import { Decimal, DecimalInput, d } from './money';

/**
 * How sales tax / VAT on a sale is treated.
 *  - `seller_liable`: the seller is VAT registered and owes the VAT contained in the price.
 *  - `marketplace_collected`: the marketplace collects and remits the tax (deemed supplier / facilitator).
 *  - `not_registered`: the seller is not registered; no tax is separated from revenue.
 * In the first two cases tax is excluded from revenue: VAT is never profit.
 */
export type TaxTreatment = 'seller_liable' | 'marketplace_collected' | 'not_registered';

/**
 * UK online-marketplace rule for imported goods, resolved per order line:
 * goods located outside the UK at the point of sale, in a consignment whose value
 * (excluding VAT) does not exceed the threshold (default £135), are treated with the
 * marketplace as the deemed supplier, so the marketplace accounts for the VAT. Goods
 * already in the UK, or consignments above the threshold, fall back to the seller's
 * own position (VAT registered or not).
 *
 * This is a configurable business rule that Fashion Rockstar's accountant has asked to
 * apply automatically; it is not tax advice. Northern Ireland and EU destinations follow
 * different rules and are not covered.
 */
export interface UkImportTaxRule {
  kind: 'uk_low_value_import';
  /** ISO country the goods ship from; null when unknown. */
  shipsFromCountry: string | null;
  sellerVatRegistered: boolean;
  /** Consignment value threshold in GBP, excluding VAT. */
  thresholdGbp: DecimalInput;
  /** Multiplier converting the sale currency into GBP (1 for GBP sales). */
  saleToGbpRate: DecimalInput;
}

export interface ResolvedTaxTreatment {
  treatment: TaxTreatment;
  reason: string;
  /** Goods value excluding VAT, in GBP, used for the threshold test (when the rule applied). */
  consignmentValueGbp?: Decimal;
}

const UK = 'GB';

export function resolveUkImportTax(rule: UkImportTaxRule, goodsValueExclVatSaleCurrency: Decimal): ResolvedTaxTreatment {
  const own: TaxTreatment = rule.sellerVatRegistered ? 'seller_liable' : 'not_registered';
  const ownLabel = rule.sellerVatRegistered ? 'seller accounts for VAT' : 'seller not VAT registered';
  const from = rule.shipsFromCountry?.trim().toUpperCase() || null;
  if (!from) {
    return { treatment: own, reason: `Ships-from country unknown; treated as UK stock (${ownLabel}). Set the supplier's ships-from country.` };
  }
  if (from === UK) return { treatment: own, reason: `Goods ship from the UK (${ownLabel}).` };
  const valueGbp = goodsValueExclVatSaleCurrency.times(d(rule.saleToGbpRate));
  const threshold = d(rule.thresholdGbp);
  if (valueGbp.lte(threshold)) {
    return {
      treatment: 'marketplace_collected',
      reason: `Goods ship from ${from} in a consignment of £${valueGbp.toFixed(2)} (≤ £${threshold.toFixed(2)}): the marketplace is the deemed supplier and accounts for the VAT.`,
      consignmentValueGbp: valueGbp,
    };
  }
  return {
    treatment: own,
    reason: `Goods ship from ${from} in a consignment of £${valueGbp.toFixed(2)} (> £${threshold.toFixed(2)}): import VAT applies and the ${ownLabel}.`,
    consignmentValueGbp: valueGbp,
  };
}
