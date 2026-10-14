import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { MARKETPLACES } from '@fr/core';
import type { Response } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { Auth, AuthContext, Public, RequirePermissions } from '../auth/decorators';
import { ApiZodBody, ZodPipe } from '../common/zod';
import { appCredentials, config } from '../config';
import { zMarketplace } from '../finance/finance.schemas';
import { InventorySyncService } from '../inventory/inventory-sync.service';
import { PrismaService } from '../prisma/prisma.service';
import { SupplierSyncService } from '../suppliers/supplier-sync.service';
import { AccountContextService } from './account-context.service';
import { AMAZON_UK_MARKETPLACE_ID, amazonConsentUrl, amazonExchangeCode } from './amazon/amazon-connector';
import { ConnectorRegistry } from './connector-registry';
import { EBAY_SCOPES, ebayAuthorizeUrl, ebayExchangeCode } from './ebay/ebay-auth';
import { makeState, readState } from './oauth-state';
import { SUPPLIER_CONNECTORS } from './supplier-connectors';
import { aliexpressAuthorizeUrl } from './suppliers/aliexpress';
import { SyncService } from './sync.service';
import { tiktokAuthorizeUrl, tiktokExchangeCode } from './tiktok/tiktok-connector';

const AccountInput = z.object({
  marketplace: zMarketplace,
  name: z.string().min(1).max(80),
  environment: z.enum(['SANDBOX', 'PRODUCTION', 'DEMO']).default('SANDBOX'),
});

/** Per-account settings the connectors need (none of these are secrets). */
const AccountSettings = z.object({
  postcode: z.string().max(20).optional(),
  country: z.string().length(2).optional(),
  location: z.string().max(80).optional(),
  paymentPolicyId: z.string().max(40).optional(),
  warehouseId: z.string().max(40).optional(),
  defaultProductType: z.string().max(60).optional(),
  shippingProviderIds: z.record(z.string()).optional(),
  sellerId: z.string().max(40).optional(),
});

const ManualCredentials = z.object({
  refreshToken: z.string().min(10).max(2000),
  sellerId: z.string().min(3).max(40),
});

@ApiTags('Integrations')
@Controller('integrations')
export class AccountsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectorRegistry,
    private readonly accounts: AccountContextService,
    private readonly sync: SyncService,
    private readonly inventorySync: InventorySyncService,
    private readonly supplierSync: SupplierSyncService,
    private readonly audit: AuditService,
  ) {}

  @Get('accounts')
  @RequirePermissions('listings.read')
  list() {
    return this.prisma.marketplaceAccount.findMany({
      orderBy: [{ marketplace: 'asc' }, { name: 'asc' }],
      select: {
        id: true, marketplace: true, name: true, environment: true, status: true, connectedAt: true, externalAccountId: true, settings: true,
        syncStates: { select: { resource: true, status: true, lastSuccessAt: true, lastAttemptAt: true, lastError: true } },
        credential: { select: { accessTokenExpiresAt: true, refreshTokenExpiresAt: true, scopes: true } },
      },
    });
  }

  @Post('accounts')
  @RequirePermissions('integrations.manage')
  @ApiZodBody(AccountInput)
  async create(@Body(new ZodPipe(AccountInput)) body: z.infer<typeof AccountInput>, @Auth() auth: AuthContext) {
    if (body.environment === 'DEMO' && !config().DEMO_MODE) throw new BadRequestException({ code: 'DEMO_DISABLED', message: 'Demo accounts require DEMO_MODE=true (never in production).' });
    const a = await this.prisma.marketplaceAccount.create({ data: { ...body, status: body.environment === 'DEMO' ? 'CONNECTED' : 'NOT_CONNECTED', connectedAt: body.environment === 'DEMO' ? new Date() : null } });
    await this.audit.record(auth, { action: 'integration.account_create', entityType: 'marketplace_account', entityId: a.id, after: a });
    return a;
  }

  @Patch('accounts/:id/settings')
  @RequirePermissions('integrations.manage')
  @ApiZodBody(AccountSettings)
  async settings(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(AccountSettings)) body: z.infer<typeof AccountSettings>, @Auth() auth: AuthContext) {
    const before = await this.prisma.marketplaceAccount.findUniqueOrThrow({ where: { id } });
    const settings = { ...((before.settings as object) ?? {}), ...body };
    await this.prisma.marketplaceAccount.update({ where: { id }, data: { settings } });
    await this.audit.record(auth, { action: 'integration.settings', entityType: 'marketplace_account', entityId: id, before: before.settings, after: settings });
    return { settings };
  }

  /** Step 1 of OAuth: the browser is sent to the marketplace's consent page. */
  @Get('accounts/:id/connect')
  @RequirePermissions('integrations.manage')
  async connect(@Param('id', ParseUUIDPipe) id: string, @Auth() auth: AuthContext) {
    const a = await this.prisma.marketplaceAccount.findUniqueOrThrow({ where: { id } });
    if (a.environment === 'DEMO') throw new BadRequestException({ code: 'DEMO', message: 'Demo accounts are always connected.' });
    const state = makeState({ kind: 'account', id, userId: auth.userId });
    const creds = appCredentials();
    const missing = a.marketplace.startsWith('EBAY') ? !creds.ebay.clientId || !creds.ebay.ruName : a.marketplace === 'AMAZON_UK' ? !creds.amazon.appId : !creds.tiktok.appKey;
    if (missing) throw new BadRequestException({ code: 'APP_NOT_CONFIGURED', message: `The ${MARKETPLACES[a.marketplace as keyof typeof MARKETPLACES].name} developer app credentials are not configured on the server (see README → “What you need to provide”).` });
    const url = a.marketplace.startsWith('EBAY') ? ebayAuthorizeUrl(state) : a.marketplace === 'AMAZON_UK' ? amazonConsentUrl(state) : tiktokAuthorizeUrl(state);
    return { url };
  }

  /** Step 2 of OAuth: the marketplace redirects back here with a code. */
  @Get('oauth/:provider/callback')
  @Public()
  async callback(@Param('provider') provider: string, @Query() q: Record<string, string>, @Res() res: Response) {
    const web = config().WEB_ORIGIN;
    const st = readState(q.state ?? '');
    if (!st) return res.redirect(`${web}/integrations?error=${encodeURIComponent('The connection request expired or was tampered with. Try again.')}`);
    try {
      if (provider === 'aliexpress') {
        await this.supplierSync.connectAliExpress(st.id, q.code ?? '');
        await this.audit.record({ userId: st.userId, email: '' }, { action: 'supplier.connect', entityType: 'supplier', entityId: st.id });
        return res.redirect(`${web}/suppliers/${st.id}?connected=1`);
      }
      if (provider === 'ebay') {
        await this.accounts.storeCredentials(st.id, await ebayExchangeCode(q.code ?? ''), { scopes: EBAY_SCOPES });
      } else if (provider === 'amazon') {
        const c = await amazonExchangeCode(q.spapi_oauth_code ?? '', q.selling_partner_id ?? '');
        await this.accounts.storeCredentials(st.id, c, { externalAccountId: c.sellerId });
      } else if (provider === 'tiktok') {
        const c = await tiktokExchangeCode(q.code ?? '');
        await this.accounts.storeCredentials(st.id, c, { externalAccountId: c.shopId });
      } else {
        throw new Error('Unknown provider');
      }
      await this.audit.record({ userId: st.userId, email: '' }, { action: 'integration.connect', entityType: 'marketplace_account', entityId: st.id, after: { provider } });
      return res.redirect(`${web}/integrations?connected=${encodeURIComponent(provider)}`);
    } catch (e) {
      return res.redirect(`${web}/integrations?error=${encodeURIComponent((e as Error).message.slice(0, 300))}`);
    }
  }

  /** Amazon private (self-authorised) apps: paste the refresh token from Seller Central. */
  @Post('accounts/:id/credentials')
  @RequirePermissions('integrations.manage')
  @ApiZodBody(ManualCredentials)
  async manualCredentials(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ManualCredentials)) body: z.infer<typeof ManualCredentials>, @Auth() auth: AuthContext) {
    const a = await this.prisma.marketplaceAccount.findUniqueOrThrow({ where: { id } });
    if (a.marketplace !== 'AMAZON_UK') throw new BadRequestException({ code: 'UNSUPPORTED', message: 'Manual credentials are only used for Amazon self-authorised apps.' });
    await this.accounts.storeCredentials(id, { refreshToken: body.refreshToken, sellerId: body.sellerId }, { externalAccountId: body.sellerId });
    await this.audit.record(auth, { action: 'integration.connect', entityType: 'marketplace_account', entityId: id, after: { method: 'self-authorised', marketplaceId: AMAZON_UK_MARKETPLACE_ID } });
    return this.test(id);
  }

  @Post('accounts/:id/disconnect')
  @HttpCode(200)
  @RequirePermissions('integrations.manage')
  async disconnect(@Param('id', ParseUUIDPipe) id: string, @Auth() auth: AuthContext) {
    await this.prisma.integrationCredential.deleteMany({ where: { accountId: id } });
    await this.prisma.marketplaceAccount.update({ where: { id }, data: { status: 'NOT_CONNECTED' } });
    await this.audit.record(auth, { action: 'integration.disconnect', entityType: 'marketplace_account', entityId: id });
    return { ok: true };
  }

  /** Connection check: a read-only call (recent orders) with the stored authorisation. */
  @Post('accounts/:id/test')
  @HttpCode(200)
  @RequirePermissions('integrations.manage')
  async test(@Param('id', ParseUUIDPipe) id: string) {
    const r = await this.accounts.run(id, 'CONNECTION_TEST', { type: 'account', id }, (ctx, c) => c.fetchOrders(ctx, new Date(Date.now() - 3_600_000)));
    return r.ok ? { ok: true, message: 'Connection works.' } : { ok: false, message: r.readable };
  }

  @Post('accounts/:id/sync/:resource')
  @HttpCode(200)
  @RequirePermissions('integrations.manage')
  async syncNow(@Param('id', ParseUUIDPipe) id: string, @Param('resource') resource: string) {
    if (resource === 'orders') return this.sync.syncOrders(id);
    if (resource === 'finance') return this.sync.syncFinance(id);
    if (resource === 'inventory') return this.inventorySync.syncAll();
    throw new BadRequestException({ code: 'UNKNOWN_RESOURCE', message: 'Use orders, finance or inventory.' });
  }

  @Post('accounts/:id/adopt-listings')
  @HttpCode(200)
  @RequirePermissions('integrations.manage', 'listings.write')
  adopt(@Param('id', ParseUUIDPipe) id: string, @Auth() auth: AuthContext) {
    return this.sync.adoptListings(id, auth.userId);
  }

  @Get('operations')
  @RequirePermissions('listings.read')
  operations(@Query('accountId') accountId?: string, @Query('status') status?: string) {
    return this.prisma.marketplaceOperation.findMany({ where: { accountId, status }, orderBy: { createdAt: 'desc' }, take: 200, include: { account: { select: { name: true } } } });
  }

  @Get('capabilities')
  capabilities() {
    return {
      marketplaces: MARKETPLACES,
      mockMode: config().MOCK_MARKETPLACES,
      matrix: this.registry.capabilityMatrix(),
      suppliers: Object.fromEntries(Object.entries(SUPPLIER_CONNECTORS).map(([k, c]) => [k, c.capabilities])),
      configured: {
        ebay: !!appCredentials().ebay.clientId,
        amazon: !!appCredentials().amazon.clientId,
        tiktok: !!appCredentials().tiktok.appKey,
        aliexpress: !!appCredentials().aliexpress.appKey,
        cj: !!appCredentials().cj.apiKey,
        ai: !!config().ANTHROPIC_API_KEY,
      },
    };
  }

  // ── Suppliers ──
  @Get('suppliers/:id/connect')
  @RequirePermissions('suppliers.write')
  async supplierConnect(@Param('id', ParseUUIDPipe) id: string, @Auth() auth: AuthContext) {
    const s = await this.prisma.supplier.findUniqueOrThrow({ where: { id } });
    if (s.type === 'ALIEXPRESS') {
      if (!appCredentials().aliexpress.appKey) throw new BadRequestException({ code: 'APP_NOT_CONFIGURED', message: 'AliExpress app key/secret are not configured on the server.' });
      return { url: aliexpressAuthorizeUrl(makeState({ kind: 'supplier', id, userId: auth.userId })) };
    }
    if (s.type === 'CJ_DROPSHIPPING') {
      if (!appCredentials().cj.apiKey) throw new BadRequestException({ code: 'APP_NOT_CONFIGURED', message: 'CJ_API_KEY is not configured on the server.' });
      await this.supplierSync.connectCj(id, auth);
      return { connected: true };
    }
    throw new BadRequestException({ code: 'MANUAL_SUPPLIER', message: 'This supplier has no API; record checks manually.' });
  }

  @Post('suppliers/sync')
  @HttpCode(200)
  @RequirePermissions('suppliers.write')
  syncSuppliers() {
    return this.supplierSync.syncAll();
  }

  @Post('supplier-products/:id/sync')
  @HttpCode(200)
  @RequirePermissions('suppliers.write')
  syncSupplierProduct(@Param('id', ParseUUIDPipe) id: string) {
    return this.supplierSync.syncSupplierProduct(id);
  }
}
