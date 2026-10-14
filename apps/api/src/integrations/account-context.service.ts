import { Injectable, NotFoundException } from '@nestjs/common';
import { MarketplaceAccount } from '@prisma/client';
import type { MarketplaceCode } from '@fr/core';
import { CryptoService } from '../common/crypto.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectorContext, ConnectorResult, MarketplaceConnector } from './connector';
import { ConnectorRegistry } from './connector-registry';

/**
 * Builds the runtime context for a marketplace account (decrypted credentials that never leave
 * the server, token persistence) and runs connector operations with logging and error handling.
 */
@Injectable()
export class AccountContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly registry: ConnectorRegistry,
    private readonly notifications: NotificationsService,
  ) {}

  async storeCredentials(accountId: string, creds: Record<string, unknown>, extra: { externalAccountId?: string | null; scopes?: string[] } = {}) {
    const enc = this.crypto.encrypt(JSON.stringify(creds));
    const expires = (k: string) => (typeof creds[k] === 'string' ? new Date(creds[k] as string) : null);
    await this.prisma.$transaction([
      this.prisma.integrationCredential.upsert({
        where: { accountId },
        update: { ...enc, scopes: extra.scopes ?? [], accessTokenExpiresAt: expires('accessTokenExpiresAt'), refreshTokenExpiresAt: expires('refreshTokenExpiresAt') },
        create: { accountId, ...enc, scopes: extra.scopes ?? [], accessTokenExpiresAt: expires('accessTokenExpiresAt'), refreshTokenExpiresAt: expires('refreshTokenExpiresAt') },
      }),
      this.prisma.marketplaceAccount.update({
        where: { id: accountId },
        data: { status: 'CONNECTED', connectedAt: new Date(), ...(extra.externalAccountId !== undefined ? { externalAccountId: extra.externalAccountId } : {}) },
      }),
    ]);
  }

  async context(accountId: string, idempotencyKey = ''): Promise<{ account: MarketplaceAccount; ctx: ConnectorContext; connector: MarketplaceConnector }> {
    const account = await this.prisma.marketplaceAccount.findUnique({ where: { id: accountId }, include: { credential: true } });
    if (!account) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Marketplace account not found.' });
    const credentials = account.credential ? (JSON.parse(this.crypto.decrypt(account.credential)) as Record<string, unknown>) : null;
    const ctx: ConnectorContext = {
      accountId,
      environment: account.environment,
      credentials,
      accountSettings: (account.settings as Record<string, unknown>) ?? {},
      idempotencyKey,
      saveCredentials: async (c) => {
        const enc = this.crypto.encrypt(JSON.stringify(c));
        await this.prisma.integrationCredential.update({
          where: { accountId },
          data: { ...enc, accessTokenExpiresAt: typeof c.accessTokenExpiresAt === 'string' ? new Date(c.accessTokenExpiresAt) : undefined },
        });
      },
    };
    return { account, ctx, connector: this.registry.forAccount({ marketplace: account.marketplace as MarketplaceCode, environment: account.environment }) };
  }

  /** Run one connector call, log it to marketplace_operations and handle revoked authorisation. */
  async run<T>(
    accountId: string,
    operation: string,
    entity: { type?: string; id?: string; jobId?: string; retryCount?: number },
    fn: (ctx: ConnectorContext, connector: MarketplaceConnector) => Promise<ConnectorResult<T>>,
    idempotencyKey = '',
  ): Promise<ConnectorResult<T>> {
    const { ctx, connector } = await this.context(accountId, idempotencyKey);
    const started = Date.now();
    let result: ConnectorResult<T>;
    try {
      result = await fn(ctx, connector);
    } catch (e) {
      result = { ok: false, transient: true, code: 'CONNECTOR_EXCEPTION', message: (e as Error).message, readable: 'The marketplace connection failed unexpectedly. It will be retried.' };
    }
    await this.prisma.marketplaceOperation.create({
      data: {
        accountId,
        operation,
        entityType: entity.type,
        entityId: entity.id,
        jobId: entity.jobId,
        status: result.ok ? 'SUCCEEDED' : result.code === 'CONNECTOR_NOT_IMPLEMENTED' ? 'UNSUPPORTED' : result.transient ? 'FAILED_TRANSIENT' : 'FAILED_PERMANENT',
        errorCode: result.ok ? null : result.code,
        errorMessage: result.ok ? null : result.message.slice(0, 2000),
        readableError: result.ok ? null : result.readable.slice(0, 2000),
        retryCount: entity.retryCount ?? 0,
        nextAction: result.ok ? null : result.authExpired ? 'Reconnect the account on the Integrations page' : result.nextAction ?? (result.transient ? 'Automatic retry' : 'Fix the data and retry'),
        httpStatus: result.ok ? null : result.httpStatus,
        durationMs: Date.now() - started,
      },
    });
    if (!result.ok && (result.authExpired || result.code === 'AUTH_EXPIRED')) {
      const acc = await this.prisma.marketplaceAccount.update({ where: { id: accountId }, data: { status: 'EXPIRED' } });
      await this.notifications.notify({ type: 'ACCOUNT_AUTH_EXPIRED', severity: 'critical', title: `${acc.name} needs reconnecting`, body: result.readable, entityType: 'marketplace_account', entityId: accountId, roleKey: 'owner' });
    }
    return result;
  }
}
