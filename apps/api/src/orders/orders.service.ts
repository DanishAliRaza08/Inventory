import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Order, OrderLine, Prisma } from '@prisma/client';
import { ActualFee as CoreActualFee, FeeType, MarketplaceCode, MissingFxRateError, NoCostRecordError, calculateOrderLineProfit, d, feeVarianceAlert } from '@fr/core';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/decorators';
import { CostsService } from '../costs/costs.service';
import { ProfitService } from '../finance/profit.service';
import { AccountContextService } from '../integrations/account-context.service';
import { NormalizedOrder } from '../integrations/connector';
import { InventoryService } from '../inventory/inventory.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { CustomerPiiService } from '../privacy/customer-pii.service';
import { SettingsService } from '../settings/settings.service';

const OPEN_STATUSES = ['PAID', 'AWAITING_DISPATCH'];

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly pii: CustomerPiiService,
    private readonly profit: ProfitService,
    private readonly costs: CostsService,
    private readonly settings: SettingsService,
    private readonly accounts: AccountContextService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  // ───────────────────────── Ingest from marketplaces ─────────────────────────

  /** Match a marketplace SKU to a master SKU: listing on this account → marketplace alias → master SKU. */
  private async matchLine(tx: Tx, accountId: string, marketplace: string, sku: string, externalListingId?: string | null) {
    const listing =
      (await tx.marketplaceListing.findFirst({ where: { accountId, sku } })) ??
      (externalListingId ? await tx.marketplaceListing.findFirst({ where: { accountId, externalListingId } }) : null);
    if (listing) return { variantId: listing.variantId, listingId: listing.id };
    const alias = await tx.skuAlias.findFirst({ where: { type: 'MARKETPLACE', scope: marketplace, alias: sku } });
    if (alias) return { variantId: alias.variantId, listingId: null };
    const v = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM product_variants WHERE lower(sku) = lower(${sku}) LIMIT 1`;
    return { variantId: v[0]?.id ?? null, listingId: null };
  }

  /**
   * Cost in force when the item was sold. Orders older than the first recorded cost (typical when
   * history is imported on day one) fall back to the earliest cost and are flagged as assumed.
   */
  private async costRecordAt(tx: Tx, variantId: string, at: Date) {
    const exact = await tx.costRecord.findFirst({
      where: { variantId, effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }] },
      orderBy: { effectiveFrom: 'desc' },
    });
    return exact ?? tx.costRecord.findFirst({ where: { variantId }, orderBy: { effectiveFrom: 'asc' } });
  }

  async ingest(accountId: string, o: NormalizedOrder): Promise<{ orderId: string; created: boolean }> {
    const account = await this.prisma.marketplaceAccount.findUniqueOrThrow({ where: { id: accountId } });
    const unmatched: string[] = [];
    const result = await this.prisma.$transaction(
      async (tx) => {
        const existing = await tx.order.findUnique({ where: { accountId_externalOrderId: { accountId, externalOrderId: o.externalOrderId } } });
        // Never move an order backwards (e.g. a stale API page after we confirmed dispatch).
        const rank: Record<string, number> = { PENDING: 0, PAID: 1, AWAITING_DISPATCH: 1, DISPATCHED: 2, DELIVERED: 3, CANCELLED: 4, REFUNDED: 4 };
        const status = existing && (rank[existing.status] ?? 0) > (rank[o.status] ?? 0) ? existing.status : o.status;
        const order = await tx.order.upsert({
          where: { accountId_externalOrderId: { accountId, externalOrderId: o.externalOrderId } },
          update: { status, dispatchBy: o.dispatchBy ? new Date(o.dispatchBy) : undefined },
          create: {
            accountId,
            marketplace: account.marketplace,
            externalOrderId: o.externalOrderId,
            status,
            orderedAt: new Date(o.orderedAt),
            dispatchBy: o.dispatchBy ? new Date(o.dispatchBy) : null,
            currency: o.currency,
            pricesIncludeTax: o.pricesIncludeTax,
            taxTreatment: o.taxCollectedByMarketplace ? 'marketplace_collected' : 'auto',
          },
        });
        if (!existing || existing.status !== status) {
          await tx.orderStatusHistory.create({ data: { orderId: order.id, fromStatus: existing?.status ?? null, toStatus: status, source: `${account.marketplace} sync` } });
        }
        for (const l of o.lines) {
          const match = await this.matchLine(tx, accountId, account.marketplace, l.sku, l.externalListingId);
          if (!match.variantId) unmatched.push(l.sku);
          const cost = match.variantId ? await this.costRecordAt(tx, match.variantId, order.orderedAt) : null;
          await tx.orderLine.upsert({
            where: { orderId_externalLineId: { orderId: order.id, externalLineId: l.externalLineId } },
            update: { variantId: match.variantId ?? undefined, listingId: match.listingId ?? undefined },
            create: {
              orderId: order.id,
              externalLineId: l.externalLineId,
              variantId: match.variantId,
              listingId: match.listingId,
              sku: l.sku,
              title: l.title.slice(0, 500),
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              shippingCharged: l.shippingCharged,
              sellerDiscount: l.sellerDiscount,
              taxAmount: l.taxAmount,
              costRecordId: cost?.id,
            },
          });
        }
        if (o.customer && !existing) await this.pii.store(order.id, o.customer, tx);
        if (o.deliveredAt) await this.pii.markDelivered(order.id, new Date(o.deliveredAt), tx);
        return { order, created: !existing, previousStatus: existing?.status ?? null };
      },
      { timeout: 30_000 },
    );
    await this.applyStock(result.order, result.previousStatus);
    if (result.created) await this.ensureSupplierFulfilment(result.order.id);
    await this.recalculateProfit(result.order.id);
    if (unmatched.length) {
      await this.notifications.notify({ type: 'ORDER_SKU_UNMATCHED', severity: 'warning', title: `Order ${o.externalOrderId}: unknown SKU`, body: `No master SKU for ${[...new Set(unmatched)].join(', ')}. Add a SKU alias so cost and stock are tracked.`, entityType: 'order', entityId: result.order.id, roleKey: 'order_manager' });
    }
    return { orderId: result.order.id, created: result.created };
  }

  /** Reserve/commit/ship/release owned stock according to the order status. Idempotent per line. */
  private async applyStock(order: Order, previousStatus: string | null) {
    const lines = await this.prisma.orderLine.findMany({ where: { orderId: order.id, variantId: { not: null } }, include: { variant: { include: { product: { select: { fulfilmentModel: true } } } } } });
    for (const line of lines.filter((l) => l.variant?.product.fulfilmentModel === 'PHYSICAL')) {
      const key = (step: string) => `order:${line.id}:${step}`;
      const done = async (step: string) => !!(await this.prisma.inventoryMovement.findUnique({ where: { idempotencyKey: key(step) } }));
      try {
        if (['PAID', 'AWAITING_DISPATCH', 'DISPATCHED', 'DELIVERED'].includes(order.status)) {
          if (!(await done('reserve'))) await this.inventory.move(line.variantId!, { type: 'RESERVE', quantity: line.quantity, idempotencyKey: key('reserve'), reason: `Order ${order.externalOrderId}`, location: 'MAIN' }, null);
          if (!(await done('commit'))) await this.inventory.move(line.variantId!, { type: 'COMMIT', quantity: line.quantity, idempotencyKey: key('commit'), reason: `Order ${order.externalOrderId}`, location: 'MAIN' }, null);
        }
        if (['DISPATCHED', 'DELIVERED'].includes(order.status) && !(await done('ship'))) {
          await this.inventory.move(line.variantId!, { type: 'SHIP', quantity: line.quantity, idempotencyKey: key('ship'), reason: `Order ${order.externalOrderId} dispatched`, location: 'MAIN' }, null);
        }
        if (order.status === 'CANCELLED' && (await done('commit')) && !(await done('ship')) && !(await done('release'))) {
          await this.inventory.move(line.variantId!, { type: 'UNCOMMIT', quantity: line.quantity, idempotencyKey: key('release'), reason: `Order ${order.externalOrderId} cancelled`, location: 'MAIN' }, null);
        }
      } catch (e) {
        if ((e as { response?: { code?: string } }).response?.code === 'INSUFFICIENT_STOCK') {
          await this.notifications.notify({ type: 'OVERSOLD', severity: 'critical', title: `Oversold: ${line.sku}`, body: `Order ${order.externalOrderId} needs ${line.quantity} but stock is not available.`, entityType: 'order', entityId: order.id, roleKey: 'order_manager' });
        } else throw e;
      }
    }
    if (previousStatus !== order.status) this.logger.debug(`Order ${order.externalOrderId}: ${previousStatus} → ${order.status}`);
  }

  /** Dropship lines get a supplier-ordering checklist (supplier order is placed only after staff confirm). */
  private async ensureSupplierFulfilment(orderId: string) {
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { lines: { include: { variant: { include: { product: true, supplierProducts: { orderBy: { priority: 'asc' }, take: 1 } } } } }, fulfilments: true } });
    if (order.fulfilments.length || !OPEN_STATUSES.includes(order.status)) return;
    const drop = order.lines.filter((l) => l.variant?.product.fulfilmentModel === 'DROPSHIP');
    const supplierId = drop[0]?.variant?.supplierProducts[0]?.supplierId ?? null;
    await this.prisma.fulfilment.create({
      data: {
        orderId,
        status: 'PENDING',
        supplierId,
        checklist: drop.length
          ? [
              { step: 'Check supplier stock and price', done: false },
              { step: 'Place the supplier order (or use “Place supplier order”)', done: false },
              { step: 'Record the supplier order reference', done: false },
              { step: 'Wait for tracking; it is sent to the marketplace automatically', done: false },
            ]
          : [{ step: 'Pick, pack and post', done: false }, { step: 'Enter carrier and tracking number', done: false }],
      },
    });
  }

  // ───────────────────────── Profit ─────────────────────────

  async recalculateProfit(orderId: string) {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { lines: { include: { costRecord: true } }, fees: true, refunds: true, returns: true },
    });
    const mp = order.marketplace as MarketplaceCode;
    const rules = await this.profit.feeRules(mp);
    const fx = await this.profit.fxTable();
    const reportingCurrency = await this.settings.get('finance.reporting_currency');
    const totalGross = order.lines.reduce((a, l) => a.plus(d(l.unitPrice.toString()).times(l.quantity)), d(0));
    for (const line of order.lines) {
      if (!line.costRecord) continue; // unmatched SKU or no cost: cannot calculate
      const share = totalGross.isZero() ? d(1).div(order.lines.length) : d(line.unitPrice.toString()).times(line.quantity).div(totalGross);
      const lineFees: CoreActualFee[] = order.fees
        .filter((f) => f.orderLineId === line.id || (!f.orderLineId && f.currency === order.currency))
        .map((f) => ({ feeType: f.feeType as FeeType, name: f.name, amount: f.orderLineId ? f.amount.toString() : d(f.amount.toString()).times(share).toFixed(4), currency: f.currency, source: f.source }));
      const refunds = order.refunds.filter((r) => r.orderLineId === line.id || !r.orderLineId);
      const ret = order.returns.find((r) => r.orderLineId === line.id);
      const tax = await this.profit.taxDefaults(mp, { variantId: line.variantId ?? undefined });
      try {
        const b = calculateOrderLineProfit({
          marketplace: mp,
          saleCurrency: order.currency,
          reportingCurrency,
          soldAt: order.orderedAt,
          quantity: line.quantity,
          unitPrice: line.unitPrice.toString(),
          shippingCharged: line.shippingCharged.toString(),
          sellerDiscount: line.sellerDiscount.toString(),
          pricesIncludeTax: order.pricesIncludeTax,
          taxTreatment: order.taxTreatment === 'marketplace_collected' ? 'marketplace_collected' : tax.taxTreatment,
          taxRatePercent: tax.taxRatePercent,
          taxAmount: line.taxAmount?.toString(),
          cost: { ...line.costRecord, effectiveFrom: line.costRecord.effectiveFrom, supplierPrice: line.costRecord.supplierPrice.toString(), supplierShipping: line.costRecord.supplierShipping.toString(), packaging: line.costRecord.packaging.toString(), importDuty: line.costRecord.importDuty.toString(), nonRecoverableTax: line.costRecord.nonRecoverableTax.toString(), fxConversionPercent: line.costRecord.fxConversionPercent.toString(), purchasePaymentPercent: line.costRecord.purchasePaymentPercent.toString(), otherPerUnit: line.costRecord.otherPerUnit.toString() },
          fulfilmentCost: line.fulfilmentCost?.toString(),
          feeRules: rules,
          actualFees: lineFees.length ? lineFees : undefined,
          settled: order.settled,
          refund: refunds.length
            ? {
                amountRefunded: refunds.reduce((a, r) => a.plus(r.orderLineId ? r.amount.toString() : d(r.amount.toString()).times(share)), d(0)).toFixed(4),
                taxRefunded: refunds.some((r) => r.taxAmount) ? refunds.reduce((a, r) => a.plus(r.taxAmount?.toString() ?? 0), d(0)).toFixed(4) : undefined,
                returnShippingCost: ret?.returnShippingCost?.toString(),
                recoveredStockValue: ret?.restockable ? d(line.costRecord.supplierPrice.toString()).times(line.quantity).toFixed(4) : undefined,
              }
            : undefined,
          fx,
        });
        if (line.costRecord.effectiveFrom > order.orderedAt) {
          b.warnings.push(`No cost was recorded when this item sold; the earliest recorded cost (from ${line.costRecord.effectiveFrom.toISOString().slice(0, 10)}) was assumed.`);
        }
        await this.prisma.$transaction([
          this.prisma.profitCalculation.updateMany({ where: { orderLineId: line.id, isCurrent: true }, data: { isCurrent: false } }),
          this.prisma.profitCalculation.create({
            data: {
              orderLineId: line.id,
              status: b.status,
              currency: b.currency,
              netRevenue: b.netRevenue.toString(),
              totalCost: b.totalProductCost.toString(),
              totalFees: b.marketplaceFees.plus(b.paymentFees).toString(),
              netProfit: b.netProfit.toString(),
              marginPercent: b.netMarginPercent?.toString(),
              reportingCurrency: b.reporting?.currency ?? b.currency,
              reportingNetProfit: b.reporting?.netProfit.toString() ?? b.netProfit.toString(),
              breakdown: JSON.parse(JSON.stringify(b, (_k, v) => (v && typeof v === 'object' && 'd' in v && 's' in v ? String(v) : v))) as Prisma.InputJsonValue,
            },
          }),
        ]);
      } catch (e) {
        if (e instanceof MissingFxRateError || e instanceof NoCostRecordError) {
          this.logger.warn(`Profit not calculated for line ${line.id}: ${(e as Error).message}`);
        } else throw e;
      }
    }
  }

  /** Compare actual fees with what the fee rules predicted and alert on large variances. */
  async checkFeeVariance(orderId: string) {
    const calcs = await this.prisma.profitCalculation.findMany({ where: { orderLine: { orderId }, isCurrent: true } });
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { lines: true } });
    if (!calcs.length || !calcs.every((c) => c.status !== 'estimated')) return;
    const rules = await this.profit.feeRules(order.marketplace as MarketplaceCode);
    if (!rules.length) return;
    let estimated = d(0);
    for (const l of order.lines) {
      const { estimateFees } = await import('@fr/core');
      estimated = estimated.plus(
        estimateFees(rules, { marketplace: order.marketplace, currency: order.currency, unitPrice: l.unitPrice.toString(), quantity: l.quantity, shippingCharged: l.shippingCharged.toString(), taxAmount: l.taxAmount?.toString() ?? 0, pricesIncludeTax: order.pricesIncludeTax, at: order.orderedAt }).reduce((a, f) => a.plus(f.amount), d(0)),
      );
    }
    const actual = calcs.reduce((a, c) => a.plus(c.totalFees.toString()), d(0));
    const alert = feeVarianceAlert(estimated, actual, await this.costs.thresholds());
    if (alert) await this.notifications.notify({ type: alert.code, severity: 'warning', title: `Unexpected fees on order ${order.externalOrderId}`, body: alert.message, entityType: 'order', entityId: orderId, roleKey: 'finance_manager' });
  }

  // ───────────────────────── Fulfilment ─────────────────────────

  /**
   * Record a shipment and send the tracking to the marketplace. The order becomes DISPATCHED only
   * once the marketplace accepts the tracking (the fulfilment event is confirmed).
   */
  async recordShipment(orderId: string, input: { carrier: string; trackingNumber: string; shippedAt?: Date; labelCost?: string; source?: string }, actor: AuthContext | null) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { lines: true, fulfilments: { orderBy: { createdAt: 'asc' } } } });
    if (!order) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Order not found.' });
    if (!OPEN_STATUSES.includes(order.status)) throw new ConflictException({ code: 'ORDER_STATE', message: `Order is ${order.status}; only paid orders awaiting dispatch can be shipped.` });
    const shippedAt = input.shippedAt ?? new Date();
    const fulfilment = order.fulfilments[0] ?? (await this.prisma.fulfilment.create({ data: { orderId, status: 'PENDING' } }));
    const shipment = await this.prisma.shipment.create({ data: { fulfilmentId: fulfilment.id, carrier: input.carrier, trackingNumber: input.trackingNumber, shippedAt, labelCost: input.labelCost, currency: input.labelCost ? order.currency : undefined } });
    const r = await this.accounts.run(order.accountId, 'PUSH_TRACKING', { type: 'order', id: orderId }, (ctx, c) =>
      c.pushTracking(ctx, { externalOrderId: order.externalOrderId, lines: order.lines.map((l) => ({ externalLineId: l.externalLineId, quantity: l.quantity })), carrier: input.carrier, trackingNumber: input.trackingNumber, shippedAt }),
    );
    if (!r.ok) {
      await this.audit.record(actor, { action: 'order.tracking_rejected', entityType: 'order', entityId: orderId, after: { readable: r.readable } });
      throw new ConflictException({ code: 'TRACKING_REJECTED', message: `The marketplace did not accept the tracking: ${r.readable}. The order is not marked as dispatched.` });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.shipment.update({ where: { id: shipment.id }, data: { pushedToMarketplaceAt: new Date() } });
      await tx.fulfilment.update({ where: { id: fulfilment.id }, data: { status: 'SHIPPED', confirmedAt: new Date(), confirmedSource: input.source ?? 'marketplace accepted tracking' } });
      await tx.order.update({ where: { id: orderId }, data: { status: 'DISPATCHED' } });
      await tx.orderStatusHistory.create({ data: { orderId, fromStatus: order.status, toStatus: 'DISPATCHED', source: input.source ?? 'tracking confirmed' } });
      if (input.labelCost) {
        const per = d(input.labelCost).div(order.lines.length);
        for (const l of order.lines) await tx.orderLine.update({ where: { id: l.id }, data: { fulfilmentCost: per.toFixed(4) } });
      }
      await this.audit.record(actor, { action: 'order.dispatched', entityType: 'order', entityId: orderId, after: { carrier: input.carrier, trackingNumber: input.trackingNumber } }, tx);
    });
    const updated = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    await this.applyStock(updated, order.status);
    await this.recalculateProfit(orderId);
    return { status: 'DISPATCHED' };
  }

  async markDelivered(orderId: string, deliveredAt: Date, actor: AuthContext | null) {
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    await this.prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: orderId }, data: { status: 'DELIVERED' } });
      await tx.orderStatusHistory.create({ data: { orderId, fromStatus: order.status, toStatus: 'DELIVERED', source: actor ? 'manual' : 'carrier' } });
      await tx.shipment.updateMany({ where: { fulfilment: { orderId } }, data: { deliveredAt } });
      await this.pii.markDelivered(orderId, deliveredAt, tx);
    });
    return { status: 'DELIVERED' };
  }

  // ───────────────────────── Refunds & returns ─────────────────────────

  async recordRefund(orderId: string, input: { amount: string; taxAmount?: string; orderLineId?: string; reason?: string; externalRefundId?: string; refundedAt?: Date; source?: string }, actor: AuthContext | null) {
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    const refund = await this.prisma.refund.upsert({
      where: { orderId_externalRefundId: { orderId, externalRefundId: input.externalRefundId ?? `manual-${Date.now()}` } },
      update: {},
      create: { orderId, orderLineId: input.orderLineId, externalRefundId: input.externalRefundId ?? `manual-${Date.now()}`, amount: input.amount, taxAmount: input.taxAmount, currency: order.currency, reason: input.reason, refundedAt: input.refundedAt ?? new Date(), source: input.source ?? 'manual' },
    });
    await this.audit.record(actor, { action: 'order.refund', entityType: 'order', entityId: orderId, after: refund });
    await this.recalculateProfit(orderId);
    return refund;
  }

  async createReturn(orderId: string, input: { orderLineId?: string; reason?: string; returnShippingCost?: string }, actor: AuthContext) {
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    const r = await this.prisma.return.create({ data: { orderId, orderLineId: input.orderLineId, status: 'REQUESTED', reason: input.reason, returnShippingCost: input.returnShippingCost, currency: order.currency, externalReturnId: `manual-${Date.now()}` } });
    await this.audit.record(actor, { action: 'return.create', entityType: 'order', entityId: orderId, after: r });
    return r;
  }

  /** Receive a return: restockable items go back to available stock, others to damaged. */
  async receiveReturn(returnId: string, input: { restockable: boolean; returnShippingCost?: string }, actor: AuthContext) {
    const ret = await this.prisma.return.findUniqueOrThrow({ where: { id: returnId } });
    if (ret.status === 'RECEIVED' || ret.status === 'CLOSED') throw new BadRequestException({ code: 'ALREADY_RECEIVED', message: 'This return was already received.' });
    const line = ret.orderLineId ? await this.prisma.orderLine.findUnique({ where: { id: ret.orderLineId }, include: { variant: { include: { product: true } } } }) : null;
    await this.prisma.return.update({ where: { id: returnId }, data: { status: 'RECEIVED', restockable: input.restockable, receivedAt: new Date(), returnShippingCost: input.returnShippingCost ?? undefined } });
    if (line?.variantId && line.variant?.product.fulfilmentModel === 'PHYSICAL') {
      await this.inventory.move(line.variantId, { type: 'RETURN', quantity: line.quantity, idempotencyKey: `return:${returnId}:in`, reason: `Return ${returnId}`, location: 'MAIN' }, actor);
      await this.inventory.move(line.variantId, { type: input.restockable ? 'RESTOCK' : 'RETURN_DAMAGED', quantity: line.quantity, idempotencyKey: `return:${returnId}:out`, reason: `Return ${returnId} inspected`, location: 'MAIN' }, actor);
    }
    await this.audit.record(actor, { action: 'return.receive', entityType: 'return', entityId: returnId, after: input });
    await this.recalculateProfit(ret.orderId);
    return { status: 'RECEIVED' };
  }

  // ───────────────────────── Queries ─────────────────────────

  async list(q: { marketplace?: string; status?: string; supplierId?: string; sku?: string; search?: string; from?: Date; to?: Date; dueWithinHours?: number; page: number; pageSize: number }) {
    const where: Prisma.OrderWhereInput = {
      marketplace: q.marketplace as never,
      status: q.status,
      orderedAt: { gte: q.from, lt: q.to },
      dispatchBy: q.dueWithinHours ? { lte: new Date(Date.now() + q.dueWithinHours * 3_600_000) } : undefined,
      lines: q.sku || q.supplierId ? { some: { sku: q.sku ? { contains: q.sku, mode: 'insensitive' } : undefined, variant: q.supplierId ? { supplierProducts: { some: { supplierId: q.supplierId } } } : undefined } } : undefined,
      OR: q.search ? [{ externalOrderId: { contains: q.search } }, ...(/^\d+$/.test(q.search) ? [{ orderNumber: Number(q.search) }] : [])] : undefined,
    };
    if (q.dueWithinHours) where.status = { in: OPEN_STATUSES };
    const [items, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: { orderedAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { account: { select: { name: true } }, lines: { select: { sku: true, quantity: true, unitPrice: true, profit: { where: { isCurrent: true }, select: { netProfit: true, status: true, reportingNetProfit: true } } } }, fulfilments: { select: { status: true } } },
      }),
      this.prisma.order.count({ where }),
    ]);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  async get(orderId: string) {
    const o = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        account: { select: { name: true, marketplace: true } },
        lines: { include: { variant: { select: { id: true, sku: true, productId: true } }, profit: { where: { isCurrent: true } } } },
        statusHistory: { orderBy: { createdAt: 'desc' } },
        fulfilments: { include: { shipments: true } },
        refunds: true,
        returns: true,
        fees: true,
        customer: { select: { country: true, purgeAfter: true, purgedAt: true } },
      },
    });
    if (!o) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Order not found.' });
    const supplierOrders = await this.prisma.supplierOrder.findMany({ where: { orderId }, include: { supplier: { select: { name: true } } } });
    return { ...o, supplierOrders };
  }

  async lineOrThrow(lineId: string): Promise<OrderLine> {
    return this.prisma.orderLine.findUniqueOrThrow({ where: { id: lineId } });
  }
}
