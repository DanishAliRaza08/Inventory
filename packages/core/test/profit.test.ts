import { describe, expect, it } from 'vitest';
import { FeeRule, FxTable, NoCostRecordError, OrderLineProfitInput, calculateOrderLineProfit, costAt, landedCost, simpleProfit } from '../src';

const base = (over: Partial<OrderLineProfitInput> = {}): OrderLineProfitInput => ({
  marketplace: 'EBAY_UK',
  saleCurrency: 'GBP',
  soldAt: new Date('2026-05-01'),
  quantity: 1,
  unitPrice: '25.00',
  pricesIncludeTax: true,
  taxTreatment: 'not_registered',
  cost: { effectiveFrom: '2026-01-01', currency: 'GBP', supplierPrice: '8.00', supplierShipping: '2.00' },
  actualFees: [{ feeType: 'final_value', name: 'Selling fee', amount: '3.00', currency: 'GBP', source: 'test' }],
  otherExpenses: '1.00',
  ...over,
});

describe('demonstration profit example (spec section 6)', () => {
  it('simpleProfit: £25 - 8 - 2 - 3 - 1 = £11 at 44%', () => {
    const r = simpleProfit({ netSalesRevenue: 25, productCost: 8, supplierShipping: 2, marketplaceFees: 3, otherExpenses: 1 });
    expect(r.netProfit.toFixed(2)).toBe('11.00');
    expect(r.netMarginPercent!.toFixed(0)).toBe('44');
  });
  it('full order-line calculation gives the same answer', () => {
    const b = calculateOrderLineProfit(base());
    expect(b.netRevenue.toFixed(2)).toBe('25.00');
    expect(b.totalProductCost.toFixed(2)).toBe('10.00');
    expect(b.marketplaceFees.toFixed(2)).toBe('3.00');
    expect(b.netProfit.toFixed(2)).toBe('11.00');
    expect(b.netMarginPercent!.toFixed(2)).toBe('44.00');
    expect(b.returnOnCostPercent!.toFixed(2)).toBe('110.00');
  });
});

describe('tax treatment', () => {
  it('VAT collected is never revenue (seller liable, VAT-inclusive price)', () => {
    const b = calculateOrderLineProfit(base({ unitPrice: '30.00', taxTreatment: 'seller_liable', taxRatePercent: 20 }));
    expect(b.taxCollected.toFixed(2)).toBe('5.00');
    expect(b.netRevenue.toFixed(2)).toBe('25.00');
    expect(b.netProfit.toFixed(2)).toBe('11.00');
  });
  it('tax-exclusive prices (US) add tax on top and exclude it from revenue', () => {
    const b = calculateOrderLineProfit(base({ pricesIncludeTax: false, taxTreatment: 'marketplace_collected', taxAmount: '2.00' }));
    expect(b.grossCharged.toFixed(2)).toBe('27.00');
    expect(b.netRevenue.toFixed(2)).toBe('25.00');
  });
  it('uses marketplace-reported tax over the configured rate', () => {
    const b = calculateOrderLineProfit(base({ unitPrice: '30.00', taxTreatment: 'marketplace_collected', taxRatePercent: 20, taxAmount: '4.00' }));
    expect(b.netRevenue.toFixed(2)).toBe('26.00');
  });
});

describe('revenue components', () => {
  it('includes customer shipping and subtracts seller-funded discounts', () => {
    const b = calculateOrderLineProfit(base({ shippingCharged: '3.99', sellerDiscount: '2.00' }));
    expect(b.netRevenue.toFixed(2)).toBe('26.99');
    expect(b.netProfit.toFixed(2)).toBe('12.99');
  });
  it('multiplies unit cost by quantity', () => {
    const b = calculateOrderLineProfit(base({ quantity: 3 }));
    expect(b.sellingPrice.toFixed(2)).toBe('75.00');
    expect(b.totalProductCost.toFixed(2)).toBe('30.00');
  });
});

describe('fees: estimated vs actual', () => {
  const rules: FeeRule[] = [
    { id: 'f', name: 'Selling fee', marketplace: 'EBAY_UK', feeType: 'final_value', basis: 'order_total_incl_tax', currency: 'GBP', percent: '12' },
    { id: 'p', name: 'Payment', marketplace: 'EBAY_UK', feeType: 'payment', basis: 'per_order', currency: 'GBP', fixed: '0.30' },
    { id: 'a', name: 'Promoted', marketplace: 'EBAY_UK', feeType: 'promoted', basis: 'item_price', currency: 'GBP', percent: '4' },
  ];
  it('estimates from rules and classifies by type', () => {
    const b = calculateOrderLineProfit(base({ actualFees: undefined, feeRules: rules }));
    expect(b.status).toBe('estimated');
    expect(b.marketplaceFees.toFixed(2)).toBe('3.00');
    expect(b.paymentFees.toFixed(2)).toBe('0.30');
    expect(b.advertisingCosts.toFixed(2)).toBe('1.00');
    expect(b.netProfit.toFixed(2)).toBe('9.70');
  });
  it('actual fees replace estimates entirely (no double counting)', () => {
    const b = calculateOrderLineProfit(base({ feeRules: rules }));
    expect(b.marketplaceFees.toFixed(2)).toBe('3.00');
    expect(b.paymentFees.toFixed(2)).toBe('0.00');
    expect(b.feeLines.every((f) => f.source === 'test')).toBe(true);
    expect(b.status).toBe('partially_reconciled');
    expect(calculateOrderLineProfit(base({ settled: true })).status).toBe('confirmed');
  });
  it('warns when there is no fee information at all', () => {
    const b = calculateOrderLineProfit(base({ actualFees: undefined }));
    expect(b.warnings.join(' ')).toMatch(/fees are assumed to be zero/);
  });
});

describe('refunds', () => {
  it('reverses revenue, adds return costs, credits fees and recovered stock once', () => {
    const b = calculateOrderLineProfit(
      base({ actualFees: undefined, feeRules: [{ id: 'f', name: 'fee', marketplace: 'EBAY_UK', feeType: 'final_value', basis: 'item_price', currency: 'GBP', percent: '12' }], refund: { amountRefunded: '25.00', returnShippingCost: '3.00', feeCredit: '2.50', recoveredStockValue: '10.00' } }),
    );
    // 25 revenue -10 cost -3 fees -1 other = 11 ; refund: 25 + 3 - 2.5 - 10 = 15.5 ; net = -4.5
    expect(b.netRefundCost.toFixed(2)).toBe('15.50');
    expect(b.netProfit.toFixed(2)).toBe('-4.50');
  });
  it('ignores a separate fee credit when actual fees are used', () => {
    const b = calculateOrderLineProfit(base({ refund: { amountRefunded: '25.00', feeCredit: '2.50' } }));
    expect(b.netRefundCost.toFixed(2)).toBe('25.00');
    expect(b.warnings.some((w) => w.includes('fee credit ignored'))).toBe(true);
  });
  it('excludes refunded VAT from the revenue reversal', () => {
    const b = calculateOrderLineProfit(base({ unitPrice: '30.00', taxTreatment: 'seller_liable', taxRatePercent: 20, refund: { amountRefunded: '30.00' } }));
    expect(b.netRefundCost.toFixed(2)).toBe('25.00');
  });
});

describe('currency handling', () => {
  const fx = new FxTable([{ base: 'USD', quote: 'GBP', rate: '0.80', asOf: '2026-01-01', source: 'manual' }]);
  it('converts a USD supplier cost into a GBP sale and records the rate', () => {
    const b = calculateOrderLineProfit(base({ fx, cost: { effectiveFrom: '2026-01-01', currency: 'USD', supplierPrice: '10.00', supplierShipping: '2.50' } }));
    expect(b.productCost.toFixed(2)).toBe('8.00');
    expect(b.supplierShipping.toFixed(2)).toBe('2.00');
    expect(b.fxConversions[0]).toMatchObject({ from: 'USD', to: 'GBP', rate: '0.8', source: 'manual' });
  });
  it('refuses to mix currencies without an FX table', () => {
    expect(() => calculateOrderLineProfit(base({ cost: { effectiveFrom: '2026-01-01', currency: 'USD', supplierPrice: '10' } }))).toThrow(/FX table/);
  });
  it('reports a USD sale in GBP using the stored rate', () => {
    const b = calculateOrderLineProfit(base({ marketplace: 'EBAY_US', saleCurrency: 'USD', reportingCurrency: 'GBP', fx, cost: { effectiveFrom: '2026-01-01', currency: 'USD', supplierPrice: '8' }, actualFees: [{ feeType: 'final_value', name: 'fee', amount: '3', currency: 'USD', source: 't' }] }));
    expect(b.currency).toBe('USD');
    expect(b.netProfit.toFixed(2)).toBe('13.00');
    expect(b.reporting!.netProfit.toFixed(2)).toBe('10.40');
    expect(b.reporting!.currency).toBe('GBP');
  });
});

describe('effective-dated costs', () => {
  const records = [
    { id: 'a', effectiveFrom: '2026-01-01', effectiveTo: '2026-04-01', currency: 'GBP', supplierPrice: '7' },
    { id: 'b', effectiveFrom: '2026-04-01', currency: 'GBP', supplierPrice: '9' },
  ];
  it('selects the cost in effect at the time of sale', () => {
    expect(costAt(records, new Date('2026-03-31')).id).toBe('a');
    expect(costAt(records, new Date('2026-04-01')).id).toBe('b');
    expect(() => costAt(records, new Date('2025-12-31'))).toThrow(NoCostRecordError);
  });
  it('computes landed cost with percentage on-costs', () => {
    const l = landedCost({ effectiveFrom: '2026-01-01', currency: 'GBP', supplierPrice: '10', supplierShipping: '2', packaging: '0.5', importDuty: '1', fxConversionPercent: '2.5', otherPerUnit: '0.2' });
    expect(l.fxConversionCost.toFixed(2)).toBe('0.30');
    expect(l.total.toFixed(2)).toBe('14.00');
  });
});
