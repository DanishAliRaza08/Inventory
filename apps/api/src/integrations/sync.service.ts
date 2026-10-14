import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InventorySyncService } from '../inventory/inventory-sync.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrdersService } from '../orders/orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { AccountContextService } from './account-context.service';
import { FinancialBatch } from './connector';

const DAY = 86_400_000;

/**
 * Scheduled pulls from each connected marketplace account: orders, then fees/refunds/settlements.
 * Each (account, resource) runs under a Postgres advisory lock and resumes from its cursor with an
 * overlap window, so duplicates are absorbed by the unique keys and nothing is missed.
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountContextService,
    private readonly orders: OrdersService,
    private readonly notifications: NotificationsService,
    private readonly inventorySync: InventorySyncService,
  ) {}

  private async withLock<T>(accountId: string, resource: string, fn: () => Promise<T>): Promise<T | { skipped: true }> {
    const key = `sync:${accountId}:${resource}`;
    const [{ locked }] = await this.prisma.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_lock(hashtext(${key})) AS locked`;
    if (!locked) return { skipped: true };
    try {
      return await fn();
    } finally {
      await this.prisma.$queryRaw`SELECT pg_advisory_unlock(hashtext(${key}))`;
    }
  }

  private async state(accountId: string, resource: string) {
    return this.prisma.syncState.upsert({ where: { accountId_resource: { accountId, resource } }, update: {}, create: { accountId, resource } });
  }

  private async finish(accountId: string, resource: string, started: Date, error?: string) {
    await this.prisma.syncState.update({
      where: { accountId_resource: { accountId, resource } },
      data: error ? { status: 'ERROR', lastAttemptAt: started, lastError: error } : { status: 'OK', lastAttemptAt: started, lastSuccessAt: started, lastError: null, cursor: started.toISOString() },
    });
  }

  async syncOrders(accountId: string) {
    return this.withLock(accountId, 'orders', async () => {
      const st = await this.state(accountId, 'orders');
      const started = new Date();
      const since = st.lastSuccessAt ? new Date(st.lastSuccessAt.getTime() - 3_600_000) : new Date(Date.now() - 30 * DAY);
      const r = await this.accounts.run(accountId, 'FETCH_ORDERS', { type: 'account', id: accountId }, (ctx, c) => c.fetchOrders(ctx, since));
      if (!r.ok) {
        await this.finish(accountId, 'orders', started, r.readable);
        return { ok: false, error: r.readable };
      }
      let created = 0;
      const touchedSkus = new Set<string>();
      for (const o of r.data.orders) {
        try {
          const res = await this.orders.ingest(accountId, o);
          if (res.created) {
            created++;
            const lines = await this.prisma.orderLine.findMany({ where: { orderId: res.orderId, variantId: { not: null } }, select: { variantId: true } });
            lines.forEach((l) => touchedSkus.add(l.variantId!));
          }
        } catch (e) {
          this.logger.error(`Order ${o.externalOrderId} failed to import: ${(e as Error).message}`);
        }
      }
      await this.finish(accountId, 'orders', started);
      // New sales change available stock on every channel: push updated quantities.
      for (const v of touchedSkus) await this.inventorySync.syncVariant(v).catch((e) => this.logger.warn(e));
      return { ok: true, fetched: r.data.orders.length, created };
    });
  }

  async syncFinance(accountId: string) {
    return this.withLock(accountId, 'finance', async () => {
      const st = await this.state(accountId, 'finance');
      const started = new Date();
      const since = st.lastSuccessAt ? new Date(st.lastSuccessAt.getTime() - 2 * DAY) : new Date(Date.now() - 60 * DAY);
      const r = await this.accounts.run(accountId, 'FETCH_FEES', { type: 'account', id: accountId }, (ctx, c) => c.fetchFinancials(ctx, since));
      if (!r.ok) {
        await this.finish(accountId, 'finance', started, r.readable);
        return { ok: false, error: r.readable };
      }
      const result = await this.applyFinancials(accountId, r.data);
      await this.finish(accountId, 'finance', started);
      return { ok: true, ...result };
    });
  }

  /** Store actual fees, refunds and settlements idempotently, then re-reconcile affected orders. */
  async applyFinancials(accountId: string, batch: FinancialBatch) {
    const account = await this.prisma.marketplaceAccount.findUniqueOrThrow({ where: { id: accountId } });
    const touched = new Set<string>();
    const orderId = async (ext: string | null) => (ext ? (await this.prisma.order.findUnique({ where: { accountId_externalOrderId: { accountId, externalOrderId: ext } }, select: { id: true } }))?.id ?? null : null);
    const lineId = async (oid: string | null, ext: string | null) => (oid && ext ? (await this.prisma.orderLine.findUnique({ where: { orderId_externalLineId: { orderId: oid, externalLineId: ext } }, select: { id: true } }))?.id ?? null : null);
    let fees = 0;
    for (const f of batch.fees) {
      const oid = await orderId(f.externalOrderId);
      const lid = await lineId(oid, f.externalLineId);
      try {
        await this.prisma.actualFee.create({
          data: { orderId: oid, orderLineId: lid, marketplace: account.marketplace, feeType: f.feeType, name: f.name, amount: f.amount, currency: f.currency, source: account.marketplace, externalRef: f.externalRef, settlementId: f.settlementId, postedAt: new Date(f.postedAt) },
        });
        fees++;
        if (oid) touched.add(oid);
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e; // already imported
      }
    }
    let refunds = 0;
    for (const rf of batch.refunds) {
      const oid = await orderId(rf.externalOrderId);
      if (!oid) continue;
      const lid = await lineId(oid, rf.externalLineId);
      const existing = await this.prisma.refund.findUnique({ where: { orderId_externalRefundId: { orderId: oid, externalRefundId: rf.externalRefundId } } });
      if (existing) continue;
      await this.orders.recordRefund(oid, { amount: rf.amount, taxAmount: rf.taxAmount ?? undefined, orderLineId: lid ?? undefined, reason: rf.reason ?? undefined, externalRefundId: rf.externalRefundId, refundedAt: new Date(rf.refundedAt), source: account.marketplace }, null);
      refunds++;
      touched.add(oid);
    }
    let settled = 0;
    for (const s of batch.settledOrders) {
      const oid = await orderId(s.externalOrderId);
      if (!oid) continue;
      const r = await this.prisma.order.updateMany({ where: { id: oid, settled: false }, data: { settled: true } });
      if (r.count) {
        settled++;
        touched.add(oid);
      }
    }
    for (const oid of touched) {
      await this.orders.recalculateProfit(oid);
      await this.orders.checkFeeVariance(oid);
    }
    return { fees, refunds, settled, ordersReconciled: touched.size };
  }

  /** Bring existing marketplace listings into the platform (no migration; confirmed by the marketplace's own data). */
  async adoptListings(accountId: string, actorId: string | null) {
    const account = await this.prisma.marketplaceAccount.findUniqueOrThrow({ where: { id: accountId } });
    const r = await this.accounts.run(accountId, 'ADOPT_EXISTING_LISTINGS', { type: 'account', id: accountId }, (ctx, c) => c.fetchExistingListings(ctx));
    if (!r.ok) return { ok: false, error: r.readable };
    let adopted = 0;
    let alreadyLinked = 0;
    const unmatched: Array<{ externalListingId: string; sku: string; title: string }> = [];
    for (const ex of r.data.listings) {
      const known = await this.prisma.marketplaceListing.findFirst({ where: { accountId, OR: [{ externalListingId: ex.externalListingId, sku: ex.sku }, { sku: ex.sku }] } });
      if (known) {
        alreadyLinked++;
        continue;
      }
      const variant =
        (await this.prisma.$queryRaw<Array<{ id: string; product_id: string }>>`SELECT id, product_id FROM product_variants WHERE lower(sku) = lower(${ex.sku}) LIMIT 1`)[0] ??
        (await this.prisma.skuAlias.findFirst({ where: { type: 'MARKETPLACE', scope: account.marketplace, alias: ex.sku }, include: { variant: true } }).then((a) => (a ? { id: a.variantId, product_id: a.variant.productId } : undefined)));
      if (!variant) {
        unmatched.push({ externalListingId: ex.externalListingId, sku: ex.sku, title: ex.title });
        continue;
      }
      await this.prisma.$transaction(async (tx) => {
        const listing = await tx.marketplaceListing.create({
          data: {
            productId: variant.product_id, variantId: variant.id, accountId, marketplace: account.marketplace, sku: ex.sku, externalListingId: ex.externalListingId,
            price: ex.price, currency: ex.currency, quantity: ex.quantity, status: ex.state === 'ENDED' ? 'ENDED' : ex.state, createdById: actorId,
          },
        });
        const v = await tx.listingVersion.create({ data: { listingId: listing.id, version: 1, content: { title: ex.title, description: '', notes: 'Adopted from the marketplace; edit and republish to manage content here.' }, createdById: actorId } });
        await tx.marketplaceListing.update({ where: { id: listing.id }, data: { currentVersionId: v.id, publishedVersionId: v.id, lastPublishedAt: new Date() } });
        await tx.listingStatusHistory.create({ data: { listingId: listing.id, fromStatus: 'INCOMPLETE', toStatus: listing.status, event: 'ADOPTED', actorId, note: `Existing ${account.marketplace} listing ${ex.externalListingId}` } });
      });
      adopted++;
    }
    if (unmatched.length) {
      await this.notifications.notify({ type: 'LISTINGS_UNMATCHED', severity: 'warning', title: `${unmatched.length} ${account.name} listing(s) need a SKU match`, body: unmatched.slice(0, 10).map((u) => `${u.sku || '(no SKU)'} – ${u.title}`).join('\n'), entityType: 'marketplace_account', entityId: accountId, roleKey: 'listing_manager' });
    }
    return { ok: true, found: r.data.listings.length, adopted, alreadyLinked, unmatched };
  }

  private async connectedAccounts() {
    return this.prisma.marketplaceAccount.findMany({ where: { status: 'CONNECTED', environment: { not: 'DEMO' } } });
  }

  async syncAllOrders() {
    for (const a of await this.connectedAccounts()) await this.syncOrders(a.id).catch((e) => this.logger.error(e));
  }

  async syncAllFinance() {
    for (const a of await this.connectedAccounts()) await this.syncFinance(a.id).catch((e) => this.logger.error(e));
  }
}
