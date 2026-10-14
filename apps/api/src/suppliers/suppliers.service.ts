import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/decorators';
import { zCurrency, zMoneyNonNeg } from '../common/zod';
import { zCountry } from '../finance/finance.schemas';
import { CostsService } from '../costs/costs.service';
import { PrismaService } from '../prisma/prisma.service';

export const SupplierInput = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.enum(['ALIEXPRESS', 'CJ_DROPSHIPPING', 'MANUAL', 'OTHER']).default('MANUAL'),
  website: z.string().url().optional(),
  contactName: z.string().max(120).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(40).optional(),
  defaultCurrency: zCurrency.default('USD'),
  /** Where this supplier normally ships from, e.g. CN for AliExpress sellers. */
  shipsFromCountry: zCountry.optional(),
  processingDays: z.number().int().nonnegative().optional(),
  deliveryDaysMin: z.number().int().nonnegative().optional(),
  deliveryDaysMax: z.number().int().nonnegative().optional(),
  reliabilityNotes: z.string().max(2000).optional(),
  notes: z.string().max(5000).optional(),
  active: z.boolean().default(true),
});

export const SupplierProductInput = z.object({
  supplierId: z.string().uuid(),
  supplierSku: z.string().max(120).optional(),
  supplierProductId: z.string().max(120).optional(),
  url: z.string().url().optional(),
  currentPrice: zMoneyNonNeg,
  shippingCost: zMoneyNonNeg.default('0'),
  currency: zCurrency,
  shipsFromCountry: zCountry.optional(),
  processingDays: z.number().int().nonnegative().optional(),
  deliveryDaysMin: z.number().int().nonnegative().optional(),
  deliveryDaysMax: z.number().int().nonnegative().optional(),
  priority: z.number().int().min(1).default(1),
});

export const PriceUpdate = z.object({
  currentPrice: zMoneyNonNeg,
  shippingCost: zMoneyNonNeg.optional(),
  currency: zCurrency.optional(),
  source: z.string().max(60).default('manual'),
  /** When true and this is the primary supplier, a new effective-dated cost record is created. */
  applyToCost: z.boolean().default(true),
});

export const StockObservation = z.object({
  stockStatus: z.enum(['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK', 'UNKNOWN', 'DISCONTINUED']),
  reportedQuantity: z.number().int().nonnegative().nullable().optional(),
  source: z.string().max(60),
  /** A human has confirmed availability with the supplier. */
  manuallyVerified: z.boolean().default(false),
});

@Injectable()
export class SuppliersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly costs: CostsService,
  ) {}

  list() {
    return this.prisma.supplier.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { products: true } } } });
  }

  async get(id: string) {
    const s = await this.prisma.supplier.findUnique({
      where: { id },
      include: {
        products: { take: 200, include: { variant: { select: { sku: true, productId: true, product: { select: { title: true } } } } } },
        connection: { select: { status: true, expiresAt: true, lastSyncAt: true, lastError: true } },
      },
    });
    if (!s) throw new NotFoundException();
    return s;
  }

  async create(input: z.infer<typeof SupplierInput>, actor: AuthContext) {
    const s = await this.prisma.supplier.create({ data: input });
    await this.audit.record(actor, { action: 'supplier.create', entityType: 'supplier', entityId: s.id, after: s });
    return s;
  }

  async update(id: string, input: Partial<z.infer<typeof SupplierInput>>, actor: AuthContext) {
    const before = await this.prisma.supplier.findUniqueOrThrow({ where: { id } });
    const s = await this.prisma.supplier.update({ where: { id }, data: input });
    await this.audit.record(actor, { action: 'supplier.update', entityType: 'supplier', entityId: id, before, after: s });
    return s;
  }

  async linkVariant(variantId: string, input: z.infer<typeof SupplierProductInput>, actor: AuthContext) {
    return this.prisma.$transaction(async (tx) => {
      const sp = await tx.supplierProduct.create({ data: { ...input, variantId } });
      await tx.supplierPriceHistory.create({
        data: { supplierProductId: sp.id, price: sp.currentPrice, shippingCost: sp.shippingCost, currency: sp.currency, source: 'link', recordedById: actor.userId },
      });
      await this.audit.record(actor, { action: 'supplier_product.link', entityType: 'variant', entityId: variantId, after: sp }, tx);
      return sp;
    });
  }

  /** Supplier price change: preserves history and (for the primary supplier) creates a new cost record. */
  async updatePrice(supplierProductId: string, input: z.infer<typeof PriceUpdate>, actor: AuthContext | null) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.supplierProduct.findUnique({ where: { id: supplierProductId } });
      if (!before) throw new NotFoundException();
      const sp = await tx.supplierProduct.update({
        where: { id: supplierProductId },
        data: { currentPrice: input.currentPrice, shippingCost: input.shippingCost ?? before.shippingCost, currency: input.currency ?? before.currency, lastPriceUpdateAt: new Date() },
      });
      await tx.supplierPriceHistory.create({
        data: { supplierProductId, price: sp.currentPrice, shippingCost: sp.shippingCost, currency: sp.currency, source: input.source, recordedById: actor?.userId },
      });
      await this.audit.record(actor, { action: 'supplier_product.price_update', entityType: 'supplier_product', entityId: supplierProductId, before, after: sp }, tx);
      let costRecord = null;
      const changed = !before.currentPrice.equals(sp.currentPrice) || !before.shippingCost.equals(sp.shippingCost) || before.currency !== sp.currency;
      if (input.applyToCost && sp.priority === 1 && changed) {
        const open = await this.costs.current(sp.variantId, tx);
        costRecord = await this.costs.addCost(
          sp.variantId,
          {
            currency: sp.currency,
            supplierPrice: sp.currentPrice.toString(),
            supplierShipping: sp.shippingCost.toString(),
            // Carry forward the non-supplier components of the current cost.
            packaging: open?.packaging.toString() ?? '0',
            importDuty: open?.importDuty.toString() ?? '0',
            nonRecoverableTax: open?.nonRecoverableTax.toString() ?? '0',
            fxConversionPercent: open?.fxConversionPercent.toString() ?? '0',
            purchasePaymentPercent: open?.purchasePaymentPercent.toString() ?? '0',
            otherPerUnit: open?.otherPerUnit.toString() ?? '0',
            source: `supplier:${input.source}`,
            verified: false,
          },
          actor,
          tx,
        );
      }
      return { supplierProduct: sp, costRecord };
    });
  }

  async recordStock(supplierProductId: string, input: z.infer<typeof StockObservation>, actor: AuthContext | null) {
    const data: Prisma.SupplierProductUpdateInput = {
      stockStatus: input.stockStatus,
      reportedQuantity: input.reportedQuantity ?? null,
      stockSource: input.source,
      stockCheckedAt: new Date(),
    };
    if (input.manuallyVerified) {
      data.manuallyVerifiedAt = new Date();
      data.manuallyVerifiedBy = actor?.userId;
    }
    const sp = await this.prisma.supplierProduct.update({ where: { id: supplierProductId }, data });
    await this.audit.record(actor, { action: 'supplier_product.stock_check', entityType: 'supplier_product', entityId: supplierProductId, after: input });
    return sp;
  }

  priceHistory(supplierProductId: string) {
    return this.prisma.supplierPriceHistory.findMany({ where: { supplierProductId }, orderBy: { observedAt: 'desc' }, take: 500 });
  }
}
