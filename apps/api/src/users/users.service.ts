import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ALL_PERMISSIONS } from '@fr/core';
import { AuditService } from '../audit/audit.service';
import { AuthService, validatePasswordStrength } from '../auth/auth.service';
import type { AuthContext } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';

const userSelect = {
  id: true, email: true, name: true, status: true, mfaEnabled: true, lastLoginAt: true, createdAt: true,
  roles: { select: { role: { select: { id: true, key: true, name: true } } } },
} as const;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.prisma.user.findMany({ select: userSelect, orderBy: { name: 'asc' } });
  }

  async create(input: { email: string; name: string; password: string; roleKeys: string[] }, actor: AuthContext) {
    const weak = validatePasswordStrength(input.password);
    if (weak) throw new BadRequestException({ code: 'WEAK_PASSWORD', message: weak });
    const roles = await this.prisma.role.findMany({ where: { key: { in: input.roleKeys } } });
    if (roles.length !== input.roleKeys.length) throw new BadRequestException({ code: 'UNKNOWN_ROLE', message: 'One or more roles do not exist.' });
    await this.assertCanGrant(roles.map((r) => r.key), actor);
    const user = await this.prisma.user.create({
      data: {
        email: input.email.toLowerCase().trim(),
        name: input.name,
        passwordHash: await this.auth.hashPassword(input.password),
        roles: { create: roles.map((r) => ({ roleId: r.id })) },
      },
      select: userSelect,
    });
    await this.audit.record(actor, { action: 'user.create', entityType: 'user', entityId: user.id, after: { email: user.email, roles: input.roleKeys } });
    return user;
  }

  async update(id: string, input: { name?: string; status?: 'ACTIVE' | 'DISABLED'; roleKeys?: string[] }, actor: AuthContext) {
    const before = await this.prisma.user.findUnique({ where: { id }, select: userSelect });
    if (!before) throw new NotFoundException();
    if (id === actor.userId && (input.status === 'DISABLED' || (input.roleKeys && !input.roleKeys.includes('owner') && actor.roles.includes('owner')))) {
      throw new ForbiddenException({ code: 'SELF_LOCKOUT', message: 'You cannot disable yourself or remove your own owner role.' });
    }
    if (input.roleKeys) await this.assertCanGrant(input.roleKeys, actor);
    const user = await this.prisma.$transaction(async (tx) => {
      if (input.roleKeys) {
        const roles = await tx.role.findMany({ where: { key: { in: input.roleKeys } } });
        if (roles.length !== input.roleKeys.length) throw new BadRequestException({ code: 'UNKNOWN_ROLE', message: 'One or more roles do not exist.' });
        await tx.userRole.deleteMany({ where: { userId: id } });
        await tx.userRole.createMany({ data: roles.map((r) => ({ userId: id, roleId: r.id })) });
      }
      return tx.user.update({ where: { id }, data: { name: input.name, status: input.status }, select: userSelect });
    });
    if (input.status === 'DISABLED') await this.auth.revokeAllSessions(id, actor);
    await this.audit.record(actor, { action: 'user.update', entityType: 'user', entityId: id, before, after: user });
    return user;
  }

  /** Only owners can grant the owner role. */
  private async assertCanGrant(roleKeys: string[], actor: AuthContext) {
    if (roleKeys.includes('owner') && !actor.roles.includes('owner')) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Only an owner can grant the owner role.' });
    }
  }

  // ── Roles ──

  listRoles() {
    return this.prisma.role.findMany({ include: { permissions: true, _count: { select: { users: true } } }, orderBy: { name: 'asc' } });
  }

  async upsertRole(input: { key: string; name: string; description?: string; permissions: string[]; requiresMfa?: boolean }, actor: AuthContext) {
    const unknown = input.permissions.filter((p) => !(ALL_PERMISSIONS as string[]).includes(p));
    if (unknown.length) throw new BadRequestException({ code: 'UNKNOWN_PERMISSION', message: `Unknown permissions: ${unknown.join(', ')}` });
    const existing = await this.prisma.role.findUnique({ where: { key: input.key }, include: { permissions: true } });
    if (existing?.isSystem && existing.key === 'owner') throw new ConflictException({ code: 'SYSTEM_ROLE', message: 'The owner role cannot be modified.' });
    const role = await this.prisma.$transaction(async (tx) => {
      const r = await tx.role.upsert({
        where: { key: input.key },
        update: { name: input.name, description: input.description ?? '', requiresMfa: input.requiresMfa ?? false },
        create: { key: input.key, name: input.name, description: input.description ?? '', requiresMfa: input.requiresMfa ?? false },
      });
      await tx.rolePermission.deleteMany({ where: { roleId: r.id } });
      await tx.rolePermission.createMany({ data: input.permissions.map((p) => ({ roleId: r.id, permissionKey: p })) });
      return tx.role.findUniqueOrThrow({ where: { id: r.id }, include: { permissions: true } });
    });
    await this.audit.record(actor, {
      action: existing ? 'role.update' : 'role.create',
      entityType: 'role',
      entityId: role.id,
      before: existing ? { permissions: existing.permissions.map((p) => p.permissionKey) } : undefined,
      after: { permissions: input.permissions },
    });
    return role;
  }
}
