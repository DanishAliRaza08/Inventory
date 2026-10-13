import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { authenticator } from 'otplib';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../common/crypto.service';
import { config } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthContext } from './decorators';

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

export const SESSION_COOKIE = 'fr_session';

// Allow one 30s step of clock drift.
authenticator.options = { window: 1 };

export function validatePasswordStrength(password: string): string | null {
  if (password.length < 12) return 'Password must be at least 12 characters.';
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
    return 'Password must contain upper-case, lower-case letters and digits.';
  }
  return null;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  hashPassword(password: string) {
    // OWASP-recommended argon2id parameters.
    return hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
  }

  async login(email: string, password: string, meta: { ip?: string; userAgent?: string }) {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    // Constant-ish work even when the user does not exist.
    const ok = user ? await verify(user.passwordHash, password).catch(() => false) : (await this.hashPassword(password), false);
    if (!user || user.status !== 'ACTIVE') throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' });
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException({ code: 'ACCOUNT_LOCKED', message: 'Too many failed attempts. Try again later.' });
    }
    if (!ok) {
      const failed = user.failedLogins + 1;
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLogins: failed, lockedUntil: failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null },
      });
      await this.audit.record({ userId: user.id, email: user.email, ...meta }, { action: 'auth.login_failed', entityType: 'user', entityId: user.id });
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' });
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });

    const token = this.crypto.randomToken();
    const session = await this.prisma.session.create({
      data: {
        tokenHash: this.crypto.sha256(token),
        userId: user.id,
        mfaVerified: !user.mfaEnabled,
        ip: meta.ip,
        userAgent: meta.userAgent?.slice(0, 500),
        expiresAt: new Date(Date.now() + config().SESSION_ABSOLUTE_HOURS * 3_600_000),
      },
    });
    await this.audit.record({ userId: user.id, email: user.email, ...meta }, { action: 'auth.login', entityType: 'session', entityId: session.id });
    return { token, mfaRequired: user.mfaEnabled, expiresAt: session.expiresAt };
  }

  /** Resolve a session cookie into an auth context, enforcing idle and absolute expiry. */
  async resolveSession(token: string, meta: { ip?: string; userAgent?: string }): Promise<AuthContext | null> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: this.crypto.sha256(token) },
      include: { user: { include: { roles: { include: { role: { include: { permissions: true } } } } } } },
    });
    if (!session || session.revokedAt || session.user.status !== 'ACTIVE') return null;
    const now = Date.now();
    if (session.expiresAt.getTime() <= now) return null;
    if (now - session.lastSeenAt.getTime() > config().SESSION_IDLE_MINUTES * 60_000) {
      await this.prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      return null;
    }
    // Throttle last-seen writes to once a minute.
    if (now - session.lastSeenAt.getTime() > 60_000) {
      await this.prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
    }
    const roles = session.user.roles.map((r) => r.role);
    return {
      userId: session.user.id,
      email: session.user.email,
      name: session.user.name,
      roles: roles.map((r) => r.key),
      permissions: new Set(roles.flatMap((r) => r.permissions.map((p) => p.permissionKey))),
      sessionId: session.id,
      mfaVerified: session.mfaVerified,
      mfaEnabled: session.user.mfaEnabled,
      requiresMfa: roles.some((r) => r.requiresMfa),
      ip: meta.ip,
      userAgent: meta.userAgent,
    };
  }

  async logout(auth: AuthContext) {
    await this.prisma.session.update({ where: { id: auth.sessionId }, data: { revokedAt: new Date() } });
    await this.audit.record(auth, { action: 'auth.logout', entityType: 'session', entityId: auth.sessionId });
  }

  async revokeAllSessions(userId: string, actor: AuthContext | null, exceptSessionId?: string) {
    const r = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null, id: exceptSessionId ? { not: exceptSessionId } : undefined },
      data: { revokedAt: new Date() },
    });
    await this.audit.record(actor, { action: 'auth.sessions_revoked', entityType: 'user', entityId: userId, after: { count: r.count } });
    return r.count;
  }

  async listSessions(userId: string) {
    return this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, ip: true, userAgent: true, createdAt: true, lastSeenAt: true, expiresAt: true, mfaVerified: true },
      orderBy: { lastSeenAt: 'desc' },
    });
  }

  // ── MFA (TOTP, RFC 6238) ──────────────────────────────────────────────

  async beginMfaEnrolment(auth: AuthContext) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (user.mfaEnabled) throw new ForbiddenException({ code: 'MFA_ALREADY_ENABLED', message: 'MFA is already enabled.' });
    const secret = authenticator.generateSecret();
    await this.prisma.user.update({ where: { id: user.id }, data: { mfaSecretEnc: this.crypto.seal(secret) } });
    return { secret, otpauthUrl: authenticator.keyuri(user.email, 'Fashion Rockstar Ops', secret) };
  }

  async confirmMfaEnrolment(auth: AuthContext, code: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (!user.mfaSecretEnc) throw new ForbiddenException({ code: 'MFA_NOT_STARTED', message: 'Start MFA enrolment first.' });
    if (!authenticator.check(code, this.crypto.unseal(user.mfaSecretEnc))) {
      throw new UnauthorizedException({ code: 'MFA_INVALID', message: 'Invalid authentication code.' });
    }
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: user.id }, data: { mfaEnabled: true } }),
      this.prisma.session.update({ where: { id: auth.sessionId }, data: { mfaVerified: true } }),
    ]);
    await this.revokeAllSessions(user.id, auth, auth.sessionId);
    await this.audit.record(auth, { action: 'auth.mfa_enabled', entityType: 'user', entityId: user.id });
  }

  async verifyMfa(auth: AuthContext, code: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (!user.mfaEnabled || !user.mfaSecretEnc) throw new ForbiddenException({ code: 'MFA_NOT_ENABLED', message: 'MFA is not enabled.' });
    if (!authenticator.check(code, this.crypto.unseal(user.mfaSecretEnc))) {
      await this.audit.record(auth, { action: 'auth.mfa_failed', entityType: 'user', entityId: user.id });
      throw new UnauthorizedException({ code: 'MFA_INVALID', message: 'Invalid authentication code.' });
    }
    await this.prisma.session.update({ where: { id: auth.sessionId }, data: { mfaVerified: true } });
  }

  async changePassword(auth: AuthContext, current: string, next: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (!(await verify(user.passwordHash, current).catch(() => false))) {
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect.' });
    }
    const weak = validatePasswordStrength(next);
    if (weak) throw new ForbiddenException({ code: 'WEAK_PASSWORD', message: weak });
    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash: await this.hashPassword(next) } });
    await this.revokeAllSessions(user.id, auth, auth.sessionId);
    await this.audit.record(auth, { action: 'auth.password_changed', entityType: 'user', entityId: user.id });
  }
}
