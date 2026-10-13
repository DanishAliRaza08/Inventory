import { ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';
import type { Permission } from '@fr/core';
import type { Request } from 'express';

export const IS_PUBLIC = 'isPublic';
export const PERMISSIONS_KEY = 'permissions';
export const ALLOW_PENDING_MFA = 'allowPendingMfa';

/** Endpoint needs no session (login, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Endpoint usable before MFA is completed / enrolled (MFA setup & verify, logout, me). */
export const AllowPendingMfa = () => SetMetadata(ALLOW_PENDING_MFA, true);
/** All listed permissions are required. Enforced server-side for every request. */
export const RequirePermissions = (...permissions: Permission[]) => SetMetadata(PERMISSIONS_KEY, permissions);

export interface AuthContext {
  userId: string;
  email: string;
  name: string;
  roles: string[];
  permissions: Set<string>;
  sessionId: string;
  mfaVerified: boolean;
  mfaEnabled: boolean;
  requiresMfa: boolean;
  ip?: string;
  userAgent?: string;
}

export type AuthedRequest = Request & { auth?: AuthContext };

export const Auth = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  return req.auth!;
});
