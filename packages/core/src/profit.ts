import { CostRecord, landedCost } from './costs';
import { FeeLine, FeeRule, FeeType, estimateFees } from './fees';
import { FxConversion, FxTable } from './fx';
import { CurrencyCode, Decimal, DecimalInput, d, money, normaliseCurrency, round2 } from './money';
import { ResolvedTaxTreatment, TaxTreatment, UkImportTaxRule, resolveUkImportTax } from './tax';

export type { TaxTreatment } from './tax';

export type ProfitStatus = 'estimated' | 'partially_reconciled' | 'confirmed';

export interface ActualFee {
  feeType: FeeType;
  name: string;
  amount: DecimalInput; // positive = charge, negative = credit
  currency: CurrencyCode;
  source: string; // e.g. "ebay-finances-api", "amazon-settlement-report"
}

export interface OrderLineProfitInput {
  marketplace: string;
  categoryId?: string;
  saleCurrency: CurrencyCode;
  reportingCurrency?: CurrencyCode;
  soldAt: Date;
  quantity: number;
  /** Price per unit charged to the buyer, before seller-funded discount. */
  unitPrice: DecimalInput;
  shippingCharged?: DecimalInput;
  /** Discount funded by the seller (reduces revenue). Marketplace-funded promotions do not. */
  sellerDiscount?: DecimalInput;
  pricesIncludeTax: boolean;
  /** A fixed treatment, or a rule resolved per line (e.g. UK low-value import rule). */
  taxTreatment: TaxTreatment | UkImportTaxRule;
  /** Tax rate in percent, used when `taxAmount` is not supplied by the marketplace. */
  taxRatePercent?: DecimalInput;
  /** Actual tax reported by the marketplace for this line, if known. */
  taxAmount?: DecimalInput;

  /** Per-unit cost record applicable at the time of sale (any currency). */
  cost: CostRecord;
  /** Outbound fulfilment / postage paid by the seller for this line, in sale currency. */
  fulfilmentCost?: DecimalInput;
  /** Advertising attributable to this line, in sale currency (beyond fee rules of type promoted). */
  advertisingCost?: DecimalInput;
  /** Other attributable per-line expenses, in sale currency. */
  otherExpenses?: DecimalInput;

  feeRules?: FeeRule[];
  /** Actual fees from the marketplace. When present they REPLACE estimated fees (never added to them). */
  actualFees?: ActualFee[];
  /** True once the marketplace settlement for this line has been imported. */
  settled?: boolean;

  refund?: {
    /** Amount refunded to the buyer, as reported (includes tax if prices include tax). */
    amountRefunded: DecimalInput;
    /** Tax portion of the refund, if known. Otherwise derived using the same tax rate. */
    taxRefunded?: DecimalInput;
    returnShippingCost?: DecimalInput;
    /** Marketplace fee credited back on refund (positive number), unless already in actualFees. */
    feeCredit?: DecimalInput;
    /** Value of returned stock that is resaleable, in sale currency (reduces cost of the return). */
    recoveredStockValue?: DecimalInput;
  };

  fx?: FxTable;
}

export interface ProfitBreakdown {
  currency: CurrencyCode;
  status: ProfitStatus;
  quantity: number;
  sellingPrice: Decimal; // unitPrice x qty
  customerShipping: Decimal;
  discounts: Decimal;
  grossCharged: Decimal; // what the buyer paid, incl. tax
  taxCollected: Decimal;
  taxTreatment: TaxTreatment;
  taxTreatmentReason: string;
  netRevenue: Decimal; // excl. tax, after discounts
  productCost: Decimal; // supplier price x qty (converted)
  supplierShipping: Decimal;
  otherProductCosts: Decimal; // packaging, duty, non-recoverable tax, fx & payment costs on purchase, other
  totalProductCost: Decimal; // landed cost x qty
  marketplaceFees: Decimal;
  paymentFees: Decimal;
  fulfilmentCosts: Decimal;
  advertisingCosts: Decimal;
  otherExpenses: Decimal;
  netRefundCost: Decimal;
  netProfit: Decimal;
  netMarginPercent: Decimal | null;
  returnOnCostPercent: Decimal | null;
  feeLines: Array<Pick<FeeLine, 'name' | 'feeType' | 'amount' | 'explanation'> & { source: string }>;
  fxConversions: Array<{ from: string; to: string; rate: string; asOf: string; source: string }>;
  reporting?: { currency: CurrencyCode; rate: string; asOf: string; source: string; netRevenue: Decimal; netProfit: Decimal };
  warnings: string[];
}

const MARKETPLACE_FEE_TYPES: FeeType[] = ['final_value', 'per_order', 'listing', 'regulatory', 'other'];

function splitTax(gross: Decimal, input: OrderLineProfitInput, treatment: TaxTreatment): Decimal {
  if (treatment === 'not_registered') return new Decimal(0);
  const rate = d(input.taxRatePercent);
  if (rate.isZero()) return new Decimal(0);
  return input.pricesIncludeTax ? gross.times(rate).div(rate.plus(100)) : gross.times(rate).div(100);
}

export function calculateOrderLineProfit(input: OrderLineProfitInput): ProfitBreakdown {
  const currency = normaliseCurrency(input.saleCurrency);
  const warnings: string[] = [];
  const fxConversions: ProfitBreakdown['fxConversions'] = [];
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) throw new Error('quantity must be a positive integer');

  // ---- Revenue -----------------------------------------------------------
  const qty = input.quantity;
  const sellingPrice = d(input.unitPrice).times(qty);
  const customerShipping = d(input.shippingCharged);
  const discounts = d(input.sellerDiscount);
  const chargedBeforeTax = sellingPrice.plus(customerShipping).minus(discounts);

  let resolved: ResolvedTaxTreatment;
  if (typeof input.taxTreatment === 'string') {
    resolved = { treatment: input.taxTreatment, reason: 'Configured tax treatment.' };
  } else {
    // Consignment value = goods (excluding shipping and VAT), per the low-value import rule.
    const goods = sellingPrice.minus(discounts);
    const rate = d(input.taxRatePercent);
    const goodsExclVat = input.pricesIncludeTax && !rate.isZero() ? goods.times(100).div(rate.plus(100)) : goods;
    resolved = resolveUkImportTax(input.taxTreatment, goodsExclVat);
  }
  const treatment = resolved.treatment;

  let taxCollected: Decimal;
  if (treatment === 'not_registered') {
    taxCollected = new Decimal(0);
  } else if (input.taxAmount !== undefined) {
    taxCollected = d(input.taxAmount);
  } else {
    taxCollected = splitTax(chargedBeforeTax, input, treatment);
    if (d(input.taxRatePercent).isZero() && treatment === 'seller_liable') {
      warnings.push('Seller is tax-liable but no tax rate or tax amount was supplied; tax assumed to be zero.');
    }
  }
  const grossCharged = input.pricesIncludeTax ? chargedBeforeTax : chargedBeforeTax.plus(taxCollected);
  const netRevenue = grossCharged.minus(taxCollected);

  // ---- Product cost ------------------------------------------------------
  const landed = landedCost(input.cost);
  let rateToSale = new Decimal(1);
  if (normaliseCurrency(landed.currency) !== currency) {
    if (!input.fx) throw new Error(`Cost is in ${landed.currency} but sale is in ${currency}; an FX table is required.`);
    const conv: FxConversion = input.fx.convert(money(1, landed.currency), currency, input.soldAt);
    rateToSale = conv.rate;
    fxConversions.push({ from: landed.currency, to: currency, rate: conv.rate.toString(), asOf: conv.rateAsOf, source: conv.rateSource });
  }
  const conv = (x: Decimal) => x.times(rateToSale).times(qty);
  const productCost = round2(conv(landed.supplierPrice));
  const supplierShipping = round2(conv(landed.supplierShipping));
  const totalProductCost = round2(conv(landed.total));
  const otherProductCosts = totalProductCost.minus(productCost).minus(supplierShipping);

  // ---- Fees --------------------------------------------------------------
  const feeLines: ProfitBreakdown['feeLines'] = [];
  const usingActualFees = !!input.actualFees && input.actualFees.length > 0;
  if (usingActualFees) {
    for (const f of input.actualFees!) {
      if (normaliseCurrency(f.currency) !== currency) {
        throw new Error(`Actual fee "${f.name}" is in ${f.currency}, sale is in ${currency}. Convert at import time.`);
      }
      feeLines.push({ name: f.name, feeType: f.feeType, amount: round2(d(f.amount)), explanation: 'actual', source: f.source });
    }
  } else if (input.feeRules?.length) {
    const est = estimateFees(input.feeRules, {
      marketplace: input.marketplace,
      categoryId: input.categoryId,
      currency,
      unitPrice: d(input.unitPrice).minus(discounts.div(qty)),
      quantity: qty,
      shippingCharged: customerShipping,
      taxAmount: taxCollected,
      pricesIncludeTax: input.pricesIncludeTax,
      at: input.soldAt,
    });
    for (const f of est) feeLines.push({ name: f.name, feeType: f.feeType, amount: f.amount, explanation: f.explanation, source: 'estimate' });
  } else {
    warnings.push('No fee rules configured and no actual fees imported: marketplace fees are assumed to be zero.');
  }
  const sumFees = (types: FeeType[]) =>
    feeLines.filter((f) => types.includes(f.feeType)).reduce((a, f) => a.plus(f.amount), new Decimal(0));
  const marketplaceFees = sumFees(MARKETPLACE_FEE_TYPES);
  const paymentFees = sumFees(['payment']);
  const fulfilmentCosts = sumFees(['fulfilment']).plus(d(input.fulfilmentCost));
  const advertisingCosts = sumFees(['promoted', 'advertising']).plus(d(input.advertisingCost));
  const otherExpenses = d(input.otherExpenses);

  // ---- Refunds / returns -------------------------------------------------
  let netRefundCost = new Decimal(0);
  if (input.refund) {
    const refunded = d(input.refund.amountRefunded);
    let refundTax: Decimal;
    if (treatment === 'not_registered') refundTax = new Decimal(0);
    else if (input.refund.taxRefunded !== undefined) refundTax = d(input.refund.taxRefunded);
    else refundTax = grossCharged.isZero() ? new Decimal(0) : refunded.times(taxCollected).div(grossCharged);
    const revenueReversed = refunded.minus(refundTax);
    // A fee credit is only applied here if actual fees don't already include it, to avoid double counting.
    const feeCredit = usingActualFees ? new Decimal(0) : d(input.refund.feeCredit);
    if (usingActualFees && input.refund.feeCredit) {
      warnings.push('Refund fee credit ignored because actual marketplace fees (which include credits) were supplied.');
    }
    netRefundCost = revenueReversed
      .plus(d(input.refund.returnShippingCost))
      .minus(feeCredit)
      .minus(d(input.refund.recoveredStockValue));
  }

  // Round every displayed component first so the breakdown always adds up exactly.
  const r = {
    netRevenue: round2(netRevenue),
    marketplaceFees: round2(marketplaceFees),
    paymentFees: round2(paymentFees),
    fulfilmentCosts: round2(fulfilmentCosts),
    advertisingCosts: round2(advertisingCosts),
    otherExpenses: round2(otherExpenses),
    netRefundCost: round2(netRefundCost),
  };
  const netProfit = r.netRevenue
    .minus(totalProductCost)
    .minus(r.marketplaceFees)
    .minus(r.paymentFees)
    .minus(r.fulfilmentCosts)
    .minus(r.advertisingCosts)
    .minus(r.otherExpenses)
    .minus(r.netRefundCost);

  const netMarginPercent = r.netRevenue.isZero() ? null : round2(netProfit.div(r.netRevenue).times(100));
  const returnOnCostPercent = totalProductCost.isZero() ? null : round2(netProfit.div(totalProductCost).times(100));

  const status: ProfitStatus = input.settled && usingActualFees ? 'confirmed' : usingActualFees ? 'partially_reconciled' : 'estimated';

  const result: ProfitBreakdown = {
    currency,
    status,
    quantity: qty,
    sellingPrice: round2(sellingPrice),
    customerShipping: round2(customerShipping),
    discounts: round2(discounts),
    grossCharged: round2(grossCharged),
    taxCollected: round2(taxCollected),
    taxTreatment: treatment,
    taxTreatmentReason: resolved.reason,
    netRevenue: r.netRevenue,
    productCost,
    supplierShipping,
    otherProductCosts: round2(otherProductCosts),
    totalProductCost,
    marketplaceFees: r.marketplaceFees,
    paymentFees: r.paymentFees,
    fulfilmentCosts: r.fulfilmentCosts,
    advertisingCosts: r.advertisingCosts,
    otherExpenses: r.otherExpenses,
    netRefundCost: r.netRefundCost,
    netProfit,
    netMarginPercent,
    returnOnCostPercent,
    feeLines,
    fxConversions,
    warnings,
  };

  if (input.reportingCurrency && normaliseCurrency(input.reportingCurrency) !== currency) {
    if (!input.fx) throw new Error(`Reporting in ${input.reportingCurrency} requires an FX table.`);
    const c = input.fx.convert(money(1, currency), input.reportingCurrency, input.soldAt);
    result.reporting = {
      currency: normaliseCurrency(input.reportingCurrency),
      rate: c.rate.toString(),
      asOf: c.rateAsOf,
      source: c.rateSource,
      netRevenue: round2(r.netRevenue.times(c.rate)),
      netProfit: round2(netProfit.times(c.rate)),
    };
  }
  return result;
}

/**
 * Simple component-based profit (used by the demonstration calculator and quick
 * what-if screens) where the user types each figure directly.
 */
export function simpleProfit(input: {
  netSalesRevenue: DecimalInput;
  productCost: DecimalInput;
  supplierShipping: DecimalInput;
  marketplaceFees: DecimalInput;
  paymentFees?: DecimalInput;
  fulfilmentCosts?: DecimalInput;
  advertisingCosts?: DecimalInput;
  otherExpenses?: DecimalInput;
  netRefundCosts?: DecimalInput;
}): { netProfit: Decimal; netMarginPercent: Decimal | null } {
  const rev = d(input.netSalesRevenue);
  const p = rev
    .minus(d(input.productCost))
    .minus(d(input.supplierShipping))
    .minus(d(input.marketplaceFees))
    .minus(d(input.paymentFees))
    .minus(d(input.fulfilmentCosts))
    .minus(d(input.advertisingCosts))
    .minus(d(input.otherExpenses))
    .minus(d(input.netRefundCosts));
  return { netProfit: round2(p), netMarginPercent: rev.isZero() ? null : round2(p.div(rev).times(100)) };
}
