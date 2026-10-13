import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { config } from '../config';
import { ALLOW_PENDING_MFA, AuthedRequest, IS_PUBLIC, PERMISSIONS_KEY } from './decorators';
import { AuthService, SESSION_COOKIE } from './auth.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_HEADER = 'x-requested-with';

/**
 * Global guard: authenticates the session cookie, enforces MFA, CSRF protection and
 * the permissions declared with @RequirePermissions. Endpoints without a
 * @RequirePermissions decorator only require a valid session.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const handlers = [ctx.getHandler(), ctx.getClass()];
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();

    // CSRF: browsers cannot send a custom header cross-origin without a CORS pre-flight we don't allow.
    if (!SAFE_METHODS.has(req.method) && !req.headers[CSRF_HEADER]) {
      throw new ForbiddenException({ code: 'CSRF', message: `Missing ${CSRF_HEADER} header.` });
    }
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, handlers)) return true;

    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    const auth = token ? await this.auth.resolveSession(token, { ip: req.ip, userAgent: req.headers['user-agent'] }) : null;
    if (!auth) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Please sign in.' });
    req.auth = auth;

    const allowPending = this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_MFA, handlers);
    if (!allowPending) {
      if (auth.mfaEnabled && !auth.mfaVerified) {
        throw new UnauthorizedException({ code: 'MFA_REQUIRED', message: 'Enter your authentication code.' });
      }
      if (config().MFA_ENFORCE_FOR_PRIVILEGED && auth.requiresMfa && !auth.mfaEnabled) {
        throw new ForbiddenException({ code: 'MFA_ENROLMENT_REQUIRED', message: 'Your role requires multi-factor authentication. Set it up to continue.' });
      }
    }

    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, handlers) ?? [];
    const missing = required.filter((p) => !auth.permissions.has(p));
    if (missing.length) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: `Missing permission: ${missing.join(', ')}` });
    }
    return true;
  }
}
