import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { landedCost, supplierPriceChangeAlert } from '@fr/core';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/decorators';
import { zCurrency, zMoneyNonNeg } from '../common/zod';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';

export const NewCostRecord = z.object({
  effectiveFrom: z.coerce.date().optional(),
  currency: zCurrency,
  supplierPrice: zMoneyNonNeg,
  supplierShipping: zMoneyNonNeg.default('0'),
  packaging: zMoneyNonNeg.default('0'),
  importDuty: zMoneyNonNeg.default('0'),
  nonRecoverableTax: zMoneyNonNeg.default('0'),
  fxConversionPercent: zMoneyNonNeg.default('0'),
  purchasePaymentPercent: zMoneyNonNeg.default('0'),
  otherPerUnit: zMoneyNonNeg.default('0'),
  source: z.string().max(60).default('manual'),
  notes: z.string().max(2000).optional(),
  verified: z.boolean().default(false),
});
export type NewCostRecordInput = z.infer<typeof NewCostRecord>;

@Injectable()
export class CostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
  ) {}

  history(variantId: string) {
    return this.prisma.costRecord.findMany({ where: { variantId }, orderBy: { effectiveFrom: 'desc' } });
  }

  async current(variantId: string, tx?: Tx) {
    return (tx ?? this.prisma).costRecord.findFirst({ where: { variantId, effectiveTo: null } });
  }

  /**
   * Record a new cost. The open record is closed at the new record's effective date; history is
   * never rewritten, so orders already sold keep the cost that applied at the time of sale.
   */
  async addCost(variantId: string, input: NewCostRecordInput, actor: AuthContext | null, txIn?: Tx) {
    const run = async (tx: Tx) => {
      const variant = await tx.productVariant.findUnique({ where: { id: variantId }, select: { id: true, sku: true } });
      if (!variant) throw new NotFoundException({ code: 'NOT_FOUND', message: 'SKU not found.' });
      // Serialise concurrent cost changes for the same SKU.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'cost:' + variantId}))`;
      const open = await tx.costRecord.findFirst({ where: { variantId, effectiveTo: null } });
      const from = input.effectiveFrom ?? new Date();
      if (open && from <= open.effectiveFrom) {
        throw new BadRequestException({
          code: 'COST_BACKDATED',
          message: `New cost must take effect after the current cost (effective ${open.effectiveFrom.toISOString()}). Historical costs cannot be rewritten.`,
        });
      }
      if (open) await tx.costRecord.update({ where: { id: open.id }, data: { effectiveTo: from } });
      const { verified, effectiveFrom: _ef, ...fields } = input;
      const created = await tx.costRecord.create({
        data: {
          ...fields,
          variantId,
          effectiveFrom: from,
          createdById: actor?.userId,
          verifiedAt: verified ? new Date() : null,
          verifiedById: verified ? actor?.userId : null,
        },
      });
      await this.audit.record(actor, { action: 'cost.change', entityType: 'variant', entityId: variantId, before: open, after: created }, tx);

      if (open && open.currency === created.currency) {
        const prev = landedCost({ ...open, currency: open.currency, effectiveFrom: open.effectiveFrom });
        const next = landedCost({ ...created, currency: created.currency, effectiveFrom: created.effectiveFrom });
        const alert = supplierPriceChangeAlert(prev.total, next.total, await this.thresholds());
        if (alert) {
          await this.notifications.notify(
            { type: alert.code, severity: alert.severity, title: `Cost increase on ${variant.sku}`, body: alert.message, entityType: 'variant', entityId: variantId, roleKey: 'owner' },
            tx,
          );
        }
      }
      return created;
    };
    return txIn ? run(txIn) : this.prisma.$transaction(run);
  }

  async verify(costId: string, actor: AuthContext) {
    const r = await this.prisma.costRecord.update({ where: { id: costId }, data: { verifiedAt: new Date(), verifiedById: actor.userId } });
    await this.audit.record(actor, { action: 'cost.verify', entityType: 'cost_record', entityId: costId });
    return r;
  }

  /** SKUs whose open cost was never verified or not within the configured window. */
  async unverified(days?: number) {
    const window = days ?? (await this.settings.get('alerts.cost_stale_after_days'));
    const cutoff = new Date(Date.now() - window * 86_400_000);
    return this.prisma.costRecord.findMany({
      where: { effectiveTo: null, OR: [{ verifiedAt: null }, { verifiedAt: { lt: cutoff } }] },
      include: { variant: { select: { sku: true, productId: true, product: { select: { title: true } } } } },
      take: 500,
      orderBy: { effectiveFrom: 'asc' },
    });
  }

  async thresholds() {
    return {
      minProfit: await this.settings.get('alerts.min_profit'),
      minMarginPercent: await this.settings.get('alerts.min_margin_percent'),
      maxRefundRatePercent: await this.settings.get('alerts.max_refund_rate_percent'),
      costStaleAfterDays: await this.settings.get('alerts.cost_stale_after_days'),
      supplierPriceIncreasePercent: await this.settings.get('alerts.supplier_price_increase_percent'),
      unexpectedFeeVariancePercent: await this.settings.get('alerts.unexpected_fee_variance_percent'),
    };
  }
}
