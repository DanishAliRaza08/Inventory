import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiZodBody, ZodPipe } from '../common/zod';
import { config } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService, SESSION_COOKIE } from './auth.service';
import { AllowPendingMfa, Auth, AuthContext, Public } from './decorators';

const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1).max(200) });
const CodeBody = z.object({ code: z.string().regex(/^\d{6}$/) });
const PasswordBody = z.object({ currentPassword: z.string(), newPassword: z.string().max(200) });

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('login')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiZodBody(LoginBody)
  async login(@Body(new ZodPipe(LoginBody)) body: z.infer<typeof LoginBody>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.login(body.email, body.password, { ip: req.ip, userAgent: req.headers['user-agent'] });
    res.cookie(SESSION_COOKIE, r.token, {
      httpOnly: true,
      secure: config().NODE_ENV === 'production' || config().NODE_ENV === 'staging',
      sameSite: 'lax',
      expires: r.expiresAt,
      path: '/',
    });
    return { mfaRequired: r.mfaRequired };
  }

  @Post('logout')
  @AllowPendingMfa()
  @HttpCode(200)
  async logout(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(auth);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @Get('me')
  @AllowPendingMfa()
  me(@Auth() auth: AuthContext) {
    return {
      id: auth.userId,
      email: auth.email,
      name: auth.name,
      roles: auth.roles,
      permissions: [...auth.permissions].sort(),
      mfaEnabled: auth.mfaEnabled,
      mfaVerified: auth.mfaVerified,
      mfaEnrolmentRequired: config().MFA_ENFORCE_FOR_PRIVILEGED && auth.requiresMfa && !auth.mfaEnabled,
      demoMode: config().DEMO_MODE,
    };
  }

  @Post('mfa/setup')
  @AllowPendingMfa()
  @HttpCode(200)
  setupMfa(@Auth() auth: AuthContext) {
    return this.auth.beginMfaEnrolment(auth);
  }

  @Post('mfa/confirm')
  @AllowPendingMfa()
  @HttpCode(200)
  @ApiZodBody(CodeBody)
  async confirmMfa(@Auth() auth: AuthContext, @Body(new ZodPipe(CodeBody)) body: z.infer<typeof CodeBody>) {
    await this.auth.confirmMfaEnrolment(auth, body.code);
    return { ok: true };
  }

  @Post('mfa/verify')
  @AllowPendingMfa()
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiZodBody(CodeBody)
  async verifyMfa(@Auth() auth: AuthContext, @Body(new ZodPipe(CodeBody)) body: z.infer<typeof CodeBody>) {
    await this.auth.verifyMfa(auth, body.code);
    return { ok: true };
  }

  @Post('password')
  @HttpCode(200)
  @ApiZodBody(PasswordBody)
  async changePassword(@Auth() auth: AuthContext, @Body(new ZodPipe(PasswordBody)) body: z.infer<typeof PasswordBody>) {
    await this.auth.changePassword(auth, body.currentPassword, body.newPassword);
    return { ok: true };
  }

  @Get('sessions')
  sessions(@Auth() auth: AuthContext) {
    return this.auth.listSessions(auth.userId);
  }

  @Delete('sessions/:id')
  async revokeSession(@Auth() auth: AuthContext, @Param('id') id: string) {
    await this.prisma.session.updateMany({ where: { id, userId: auth.userId }, data: { revokedAt: new Date() } });
    return { ok: true };
  }
}
