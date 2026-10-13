import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { FeeRule as DbFeeRule } from '@prisma/client';
import {
  CostRecord,
  FeeRule,
  FxTable,
  MARKETPLACES,
  MarketplaceCode,
  OrderLineProfitInput,
  TaxTreatment,
  breakEvenPrice,
  calculateOrderLineProfit,
  profitAlerts,
  solveUnitPrice,
} from '@fr/core';
import { z } from 'zod';
import { CostsService } from '../costs/costs.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { CalculateInput, ReversePriceInput } from './finance.schemas';

export function toCoreFeeRule(r: DbFeeRule): FeeRule {
  return {
    id: r.id,
    name: r.name,
    marketplace: r.marketplace,
    feeType: r.feeType as FeeRule['feeType'],
    basis: r.basis as FeeRule['basis'],
    currency: r.currency,
    percent: r.percent?.toString(),
    tiers: (r.tiers as unknown as FeeRule["tiers"]) ?? undefined,
    fixed: r.fixed?.toString(),
    minFee: r.minFee?.toString(),
    maxFee: r.maxFee?.toString(),
    categoryIds: r.categoryIds,
    overrideGroup: r.overrideGroup ?? undefined,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo,
    active: r.active,
  };
}

type CalcInput = z.infer<typeof CalculateInput>;

@Injectable()
export class ProfitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly costs: CostsService,
  ) {}

  async fxTable() {
    const rates = await this.prisma.currencyRate.findMany({ orderBy: { asOf: 'desc' }, take: 5000 });
    return new FxTable(rates.map((r) => ({ base: r.base, quote: r.quote, rate: r.rate.toString(), asOf: r.asOf, source: r.source })));
  }

  async feeRules(marketplace: MarketplaceCode) {
    const rules = await this.prisma.feeRule.findMany({ where: { marketplace, active: true } });
    return rules.map(toCoreFeeRule);
  }

  /**
   * Default tax handling per marketplace context. UK listings are VAT-inclusive and the
   * VAT-registered seller is liable; US marketplaces collect sales tax as marketplace
   * facilitators and prices are shown before tax. Overridable per calculation.
   */
  async taxDefaults(marketplace: MarketplaceCode) {
    const vatRegistered = await this.settings.get('finance.vat_registered');
    const rate = await this.settings.get('finance.default_vat_rate_percent');
    if (MARKETPLACES[marketplace].country === 'US') {
      return { pricesIncludeTax: false, taxTreatment: 'marketplace_collected' as TaxTreatment, taxRatePercent: '0' };
    }
    return { pricesIncludeTax: true, taxTreatment: (vatRegistered ? 'seller_liable' : 'not_registered') as TaxTreatment, taxRatePercent: vatRegistered ? rate : '0' };
  }

  private async resolveCost(input: Pick<CalcInput, 'variantId' | 'cost'>): Promise<CostRecord & { id?: string }> {
    if (input.cost) return { ...input.cost, effectiveFrom: new Date(0) };
    const rec = await this.costs.current(input.variantId!);
    if (!rec) throw new BadRequestException({ code: 'NO_COST', message: 'This SKU has no cost recorded yet. Add a cost before calculating profit.' });
    return {
      id: rec.id,
      effectiveFrom: rec.effectiveFrom,
      currency: rec.currency,
      supplierPrice: rec.supplierPrice.toString(),
      supplierShipping: rec.supplierShipping.toString(),
      packaging: rec.packaging.toString(),
      importDuty: rec.importDuty.toString(),
      nonRecoverableTax: rec.nonRecoverableTax.toString(),
      fxConversionPercent: rec.fxConversionPercent.toString(),
      purchasePaymentPercent: rec.purchasePaymentPercent.toString(),
      otherPerUnit: rec.otherPerUnit.toString(),
      verifiedAt: rec.verifiedAt,
    };
  }

  private async buildBase(input: Omit<CalcInput, 'unitPrice'>): Promise<Omit<OrderLineProfitInput, 'unitPrice'>> {
    const mp = input.marketplace as MarketplaceCode;
    const tax = await this.taxDefaults(mp);
    return {
      marketplace: mp,
      categoryId: input.categoryId,
      saleCurrency: MARKETPLACES[mp].currency,
      reportingCurrency: input.reportingCurrency ?? (await this.settings.get('finance.reporting_currency')),
      soldAt: new Date(),
      quantity: input.quantity,
      shippingCharged: input.shippingCharged,
      sellerDiscount: input.sellerDiscount,
      pricesIncludeTax: input.pricesIncludeTax ?? tax.pricesIncludeTax,
      taxTreatment: input.taxTreatment ?? tax.taxTreatment,
      taxRatePercent: input.taxRatePercent ?? tax.taxRatePercent,
      cost: await this.resolveCost(input),
      fulfilmentCost: input.fulfilmentCost,
      advertisingCost: input.advertisingCost,
      otherExpenses: input.otherExpenses,
      feeRules: await this.feeRules(mp),
      fx: await this.fxTable(),
    };
  }

  async calculate(input: CalcInput) {
    const base = await this.buildBase(input);
    const breakdown = calculateOrderLineProfit({ ...base, unitPrice: input.unitPrice });
    const thresholds = await this.costs.thresholds();
    const breakEven = breakEvenPrice(base);
    return {
      breakdown,
      alerts: profitAlerts(breakdown, thresholds),
      minimumProfitablePrice: breakEven.achievable ? breakEven.unitPrice : null,
      assumptions: { tax: { pricesIncludeTax: base.pricesIncludeTax, taxTreatment: base.taxTreatment, taxRatePercent: base.taxRatePercent }, feeRuleCount: base.feeRules?.length ?? 0 },
    };
  }

  async reversePrice(input: z.infer<typeof ReversePriceInput>) {
    const base = await this.buildBase(input);
    return solveUnitPrice({ base, target: input.target, ending: input.ending });
  }

  /** Minimum profitable price for a SKU on a marketplace (used by listing validation). */
  async minimumProfitablePrice(variantId: string, marketplace: MarketplaceCode, opts: { categoryId?: string; fulfilmentCost?: string } = {}) {
    const has = await this.costs.current(variantId);
    if (!has) return null;
    try {
      const base = await this.buildBase({
        marketplace,
        variantId,
        quantity: 1,
        shippingCharged: '0',
        sellerDiscount: '0',
        fulfilmentCost: opts.fulfilmentCost ?? '0',
        advertisingCost: '0',
        otherExpenses: '0',
        categoryId: opts.categoryId,
      });
      const r = breakEvenPrice(base);
      return r.achievable ? r.unitPrice : null;
    } catch {
      return null; // e.g. missing FX rate: validation will surface it separately
    }
  }

  async variantProfitAcrossMarketplaces(variantId: string) {
    const listings = await this.prisma.marketplaceListing.findMany({ where: { variantId, price: { not: null }, status: { not: 'ARCHIVED' } } });
    if (!listings.length) throw new NotFoundException({ code: 'NO_PRICED_LISTINGS', message: 'No priced listings for this SKU.' });
    const out = [];
    for (const l of listings) {
      try {
        out.push({ listingId: l.id, marketplace: l.marketplace, price: l.price, ...(await this.calculate({ marketplace: l.marketplace, variantId, unitPrice: l.price!.toString(), quantity: 1, shippingCharged: '0', sellerDiscount: '0', fulfilmentCost: '0', advertisingCost: '0', otherExpenses: '0' })) });
      } catch (e) {
        out.push({ listingId: l.id, marketplace: l.marketplace, price: l.price, error: (e as Error).message });
      }
    }
    return out;
  }
}
