import { CurrencyCode, Decimal, DecimalInput, d, normaliseCurrency, round2 } from './money';

/**
 * Configurable marketplace fee rules.
 *
 * Nothing here encodes an actual marketplace fee schedule: the operator enters
 * the rates that apply to their account and category, and whenever a marketplace
 * reports the actual fee for an order those actual values replace the estimate.
 */
export const FEE_TYPES = [
  'final_value', // marketplace selling / referral / commission fee
  'per_order', // fixed per-order fee
  'payment', // transaction / payment processing
  'listing', // insertion / listing fee
  'promoted', // promoted listing / ad-rate fee charged as % of sale
  'advertising', // other advertising attributable to the line
  'fulfilment', // marketplace fulfilment charges
  'regulatory', // regulatory operating fees, digital services surcharge etc.
  'other',
] as const;
export type FeeType = (typeof FEE_TYPES)[number];

export const FEE_BASES = [
  'item_price', // unit price x quantity, as charged to the buyer
  'item_price_plus_shipping', // item total + shipping charged to the buyer
  'order_total_incl_tax', // item + shipping including any tax charged
  'order_total_excl_tax', // item + shipping excluding tax
  'per_unit', // fixed amount per unit (use `fixed`)
  'per_order', // fixed amount per order line (use `fixed`)
] as const;
export type FeeBasis = (typeof FEE_BASES)[number];

export interface FeeTier {
  /** Upper bound of this band of the basis amount (inclusive). Omit for the final band. */
  upTo?: DecimalInput;
  percent: DecimalInput;
}

export interface FeeRule {
  id: string;
  name: string;
  marketplace: string;
  feeType: FeeType;
  basis: FeeBasis;
  currency: CurrencyCode;
  /** Flat percentage applied to the basis. Ignored when `tiers` is supplied. */
  percent?: DecimalInput;
  /** Progressive percentage bands applied to the basis. */
  tiers?: FeeTier[];
  /** Fixed amount (per order line for percentage bases, per unit for `per_unit`). */
  fixed?: DecimalInput;
  minFee?: DecimalInput;
  maxFee?: DecimalInput;
  /** Restrict to these marketplace category ids. Empty/omitted = all categories. */
  categoryIds?: string[];
  /**
   * Rules sharing an override group compete: the most specific match
   * (category-specific beats generic) wins. Rules without a group always apply.
   */
  overrideGroup?: string;
  effectiveFrom?: Date | string;
  effectiveTo?: Date | string | null;
  active?: boolean;
}

export interface FeeContext {
  marketplace: string;
  categoryId?: string;
  currency: CurrencyCode;
  unitPrice: DecimalInput; // price per unit as charged to the buyer (incl. tax if pricesIncludeTax)
  quantity: number;
  shippingCharged: DecimalInput; // as charged to the buyer
  taxAmount: DecimalInput; // tax included in / added to the buyer's total
  pricesIncludeTax: boolean;
  at: Date;
}

export interface FeeLine {
  ruleId: string;
  name: string;
  feeType: FeeType;
  amount: Decimal;
  currency: CurrencyCode;
  basisAmount: Decimal;
  explanation: string;
}

function inEffect(rule: FeeRule, at: Date): boolean {
  if (rule.active === false) return false;
  if (rule.effectiveFrom && new Date(rule.effectiveFrom).getTime() > at.getTime()) return false;
  if (rule.effectiveTo && new Date(rule.effectiveTo).getTime() <= at.getTime()) return false;
  return true;
}

function matchesCategory(rule: FeeRule, categoryId?: string): boolean {
  if (!rule.categoryIds || rule.categoryIds.length === 0) return true;
  return !!categoryId && rule.categoryIds.includes(categoryId);
}

function specificity(rule: FeeRule): number {
  return rule.categoryIds && rule.categoryIds.length > 0 ? 1 : 0;
}

/** Select applicable rules, resolving override groups to their most specific member. */
export function selectFeeRules(rules: FeeRule[], ctx: FeeContext): FeeRule[] {
  const applicable = rules.filter(
    (r) => r.marketplace === ctx.marketplace && inEffect(r, ctx.at) && matchesCategory(r, ctx.categoryId),
  );
  const ungrouped = applicable.filter((r) => !r.overrideGroup);
  const groups = new Map<string, FeeRule[]>();
  for (const r of applicable.filter((x) => x.overrideGroup)) {
    const list = groups.get(r.overrideGroup!) ?? [];
    list.push(r);
    groups.set(r.overrideGroup!, list);
  }
  const winners = [...groups.values()].map(
    (list) =>
      [...list].sort((a, b) => {
        const s = specificity(b) - specificity(a);
        if (s !== 0) return s;
        // Most recently effective wins among equally specific rules.
        return new Date(b.effectiveFrom ?? 0).getTime() - new Date(a.effectiveFrom ?? 0).getTime();
      })[0]!,
  );
  return [...ungrouped, ...winners];
}

export function basisAmount(basis: FeeBasis, ctx: FeeContext): Decimal {
  const items = d(ctx.unitPrice).times(ctx.quantity);
  const ship = d(ctx.shippingCharged);
  const tax = d(ctx.taxAmount);
  const totalInclTax = ctx.pricesIncludeTax ? items.plus(ship) : items.plus(ship).plus(tax);
  switch (basis) {
    case 'item_price':
      return items;
    case 'item_price_plus_shipping':
      return items.plus(ship);
    case 'order_total_incl_tax':
      return totalInclTax;
    case 'order_total_excl_tax':
      return totalInclTax.minus(tax);
    case 'per_unit':
      return new Decimal(ctx.quantity);
    case 'per_order':
      return new Decimal(1);
  }
}

function tieredPercent(amount: Decimal, tiers: FeeTier[]): Decimal {
  let remaining = amount;
  let lower = new Decimal(0);
  let fee = new Decimal(0);
  for (const tier of tiers) {
    if (remaining.lte(0)) break;
    const upper = tier.upTo === undefined ? null : d(tier.upTo);
    const band = upper ? Decimal.min(remaining, upper.minus(lower)) : remaining;
    if (band.gt(0)) fee = fee.plus(band.times(d(tier.percent)).div(100));
    remaining = remaining.minus(band);
    if (upper) lower = upper;
  }
  return fee;
}

export function evaluateFeeRule(rule: FeeRule, ctx: FeeContext): FeeLine {
  if (normaliseCurrency(rule.currency) !== normaliseCurrency(ctx.currency)) {
    throw new Error(
      `Fee rule "${rule.name}" is configured in ${rule.currency} but the sale is in ${ctx.currency}. ` +
        'Configure fee rules per marketplace currency.',
    );
  }
  const base = basisAmount(rule.basis, ctx);
  let amount: Decimal;
  let explanation: string;
  if (rule.basis === 'per_unit' || rule.basis === 'per_order') {
    amount = base.times(d(rule.fixed));
    explanation = `${d(rule.fixed).toFixed(2)} x ${base.toString()} ${rule.basis === 'per_unit' ? 'unit(s)' : 'order line'}`;
  } else {
    const pct = rule.tiers?.length ? tieredPercent(base, rule.tiers) : base.times(d(rule.percent)).div(100);
    amount = pct.plus(d(rule.fixed));
    explanation = rule.tiers?.length
      ? `tiered % of ${rule.basis} ${base.toFixed(2)}`
      : `${d(rule.percent).toString()}% of ${rule.basis} ${base.toFixed(2)}` +
        (rule.fixed ? ` + ${d(rule.fixed).toFixed(2)} fixed` : '');
  }
  if (rule.minFee !== undefined && amount.lt(d(rule.minFee))) {
    amount = d(rule.minFee);
    explanation += ` (raised to minimum ${d(rule.minFee).toFixed(2)})`;
  }
  if (rule.maxFee !== undefined && amount.gt(d(rule.maxFee))) {
    amount = d(rule.maxFee);
    explanation += ` (capped at ${d(rule.maxFee).toFixed(2)})`;
  }
  return {
    ruleId: rule.id,
    name: rule.name,
    feeType: rule.feeType,
    amount: round2(amount),
    currency: ctx.currency,
    basisAmount: base,
    explanation,
  };
}

export function estimateFees(rules: FeeRule[], ctx: FeeContext): FeeLine[] {
  return selectFeeRules(rules, ctx).map((r) => evaluateFeeRule(r, ctx));
}
