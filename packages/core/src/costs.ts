import { CurrencyCode, Decimal, DecimalInput, d } from './money';

/**
 * An effective-dated per-unit cost record. A new record is created whenever a
 * cost changes; old records are closed (effectiveTo) rather than overwritten, so
 * historical orders keep the cost assumptions that applied when they were sold.
 */
export interface CostRecord {
  id?: string;
  effectiveFrom: Date | string;
  effectiveTo?: Date | string | null;
  currency: CurrencyCode;
  supplierPrice: DecimalInput;
  supplierShipping?: DecimalInput;
  packaging?: DecimalInput;
  importDuty?: DecimalInput;
  nonRecoverableTax?: DecimalInput;
  /** Percentage added to cover currency conversion spread on purchases (e.g. 2.5 = 2.5%). */
  fxConversionPercent?: DecimalInput;
  /** Payment cost on purchases (e.g. card surcharge), percentage of supplier price + shipping. */
  purchasePaymentPercent?: DecimalInput;
  otherPerUnit?: DecimalInput;
  verifiedAt?: Date | string | null;
}

export class NoCostRecordError extends Error {
  constructor(at: Date) {
    super(`No cost record in effect at ${at.toISOString()}. Profit cannot be calculated without a cost.`);
    this.name = 'NoCostRecordError';
  }
}

/** Return the cost record in effect at `at` (latest effectiveFrom <= at, not yet closed). */
export function costAt<T extends CostRecord>(records: T[], at: Date): T {
  const t = at.getTime();
  const match = records
    .filter((r) => new Date(r.effectiveFrom).getTime() <= t && (!r.effectiveTo || new Date(r.effectiveTo).getTime() > t))
    .sort((a, b) => new Date(b.effectiveFrom).getTime() - new Date(a.effectiveFrom).getTime())[0];
  if (!match) throw new NoCostRecordError(at);
  return match;
}

export interface LandedCostBreakdown {
  currency: CurrencyCode;
  supplierPrice: Decimal;
  supplierShipping: Decimal;
  packaging: Decimal;
  importDuty: Decimal;
  nonRecoverableTax: Decimal;
  fxConversionCost: Decimal;
  purchasePaymentCost: Decimal;
  otherPerUnit: Decimal;
  total: Decimal;
}

/** Per-unit landed / fulfilment cost in the cost record's own currency. */
export function landedCost(r: CostRecord): LandedCostBreakdown {
  const supplierPrice = d(r.supplierPrice);
  const supplierShipping = d(r.supplierShipping);
  const purchaseBase = supplierPrice.plus(supplierShipping);
  const fxConversionCost = purchaseBase.times(d(r.fxConversionPercent)).div(100);
  const purchasePaymentCost = purchaseBase.times(d(r.purchasePaymentPercent)).div(100);
  const packaging = d(r.packaging);
  const importDuty = d(r.importDuty);
  const nonRecoverableTax = d(r.nonRecoverableTax);
  const otherPerUnit = d(r.otherPerUnit);
  const total = purchaseBase
    .plus(fxConversionCost)
    .plus(purchasePaymentCost)
    .plus(packaging)
    .plus(importDuty)
    .plus(nonRecoverableTax)
    .plus(otherPerUnit);
  return {
    currency: r.currency,
    supplierPrice,
    supplierShipping,
    packaging,
    importDuty,
    nonRecoverableTax,
    fxConversionCost,
    purchasePaymentCost,
    otherPerUnit,
    total,
  };
}

/** Days since the cost was last verified (Infinity if never). */
export function costAgeDays(r: CostRecord, now = new Date()): number {
  if (!r.verifiedAt) return Number.POSITIVE_INFINITY;
  return (now.getTime() - new Date(r.verifiedAt).getTime()) / 86_400_000;
}
