import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { MARKETPLACES } from '@fr/core';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { Auth, AuthContext, RequirePermissions } from '../auth/decorators';
import { ApiZodBody, ZodPipe } from '../common/zod';
import { config } from '../config';
import { zMarketplace } from '../finance/finance.schemas';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectorRegistry } from './connector-registry';

const AccountInput = z.object({
  marketplace: zMarketplace,
  name: z.string().min(1).max(80),
  environment: z.enum(['SANDBOX', 'PRODUCTION', 'DEMO']).default('SANDBOX'),
});

@ApiTags('Integrations')
@Controller('integrations')
export class AccountsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectorRegistry,
    private readonly audit: AuditService,
  ) {}

  /** Accounts never expose credentials; only connection metadata. */
  @Get('accounts')
  @RequirePermissions('listings.read')
  accounts() {
    return this.prisma.marketplaceAccount.findMany({
      orderBy: [{ marketplace: 'asc' }, { name: 'asc' }],
      select: {
        id: true, marketplace: true, name: true, environment: true, status: true, connectedAt: true, externalAccountId: true,
        syncStates: { select: { resource: true, status: true, lastSuccessAt: true, lastAttemptAt: true, lastError: true } },
        credential: { select: { accessTokenExpiresAt: true, refreshTokenExpiresAt: true, scopes: true } },
      },
    });
  }

  @Post('accounts')
  @RequirePermissions('integrations.manage')
  @ApiZodBody(AccountInput)
  async create(@Body(new ZodPipe(AccountInput)) body: z.infer<typeof AccountInput>, @Auth() auth: AuthContext) {
    if (body.environment === 'DEMO' && !config().DEMO_MODE) {
      throw new BadRequestException({ code: 'DEMO_DISABLED', message: 'Demo accounts require DEMO_MODE=true (never in production).' });
    }
    const a = await this.prisma.marketplaceAccount.create({
      data: { ...body, status: body.environment === 'DEMO' ? 'CONNECTED' : 'NOT_CONNECTED', connectedAt: body.environment === 'DEMO' ? new Date() : null },
    });
    await this.audit.record(auth, { action: 'integration.account_create', entityType: 'marketplace_account', entityId: a.id, after: a });
    return a;
  }

  @Get('capabilities')
  capabilities() {
    return { marketplaces: MARKETPLACES, matrix: this.registry.capabilityMatrix() };
  }
}
