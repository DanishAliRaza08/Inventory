import { describe, expect, it } from 'vitest';
import { FeeRule, breakEvenPrice, calculateOrderLineProfit, solveUnitPrice } from '../src';

const rules: FeeRule[] = [
  { id: 'f', name: 'Selling fee', marketplace: 'EBAY_UK', feeType: 'final_value', basis: 'order_total_incl_tax', currency: 'GBP', percent: '12.8' },
  { id: 'o', name: 'Per order', marketplace: 'EBAY_UK', feeType: 'per_order', basis: 'per_order', currency: 'GBP', fixed: '0.30' },
];
const base = {
  marketplace: 'EBAY_UK', saleCurrency: 'GBP', soldAt: new Date('2026-05-01'), quantity: 1, pricesIncludeTax: true,
  taxTreatment: 'seller_liable' as const, taxRatePercent: 20, feeRules: rules, fulfilmentCost: '2.70',
  cost: { effectiveFrom: '2026-01-01', currency: 'GBP', supplierPrice: '6.00', supplierShipping: '1.50', packaging: '0.25' },
};

describe('reverse price calculator', () => {
  it('finds the lowest price that achieves a target profit', () => {
    const r = solveUnitPrice({ base, target: { kind: 'profit', amount: 5 } });
    expect(r.achievable).toBe(true);
    expect(r.breakdown!.netProfit.gte(5)).toBe(true);
    const oneLess = calculateOrderLineProfit({ ...base, unitPrice: r.unitPrice!.minus(0.01) });
    expect(oneLess.netProfit.lt(5)).toBe(true);
  });
  it('finds the lowest price that achieves a target margin', () => {
    const r = solveUnitPrice({ base, target: { kind: 'margin', percent: 25 } });
    expect(r.breakdown!.netMarginPercent!.gte(25)).toBe(true);
    const oneLess = calculateOrderLineProfit({ ...base, unitPrice: r.unitPrice!.minus(0.01) });
    expect(oneLess.netProfit.div(oneLess.netRevenue).times(100).lt(25)).toBe(true);
  });
  it('computes a break-even (minimum profitable) price', () => {
    const r = breakEvenPrice(base);
    expect(r.breakdown!.netProfit.gte(0)).toBe(true);
    expect(calculateOrderLineProfit({ ...base, unitPrice: r.unitPrice!.minus(0.01) }).netProfit.lt(0)).toBe(true);
  });
  it('applies .99 price endings without dropping below the target', () => {
    const r = solveUnitPrice({ base, target: { kind: 'profit', amount: 5 }, ending: '.99' });
    expect(r.unitPrice!.toFixed(2).endsWith('.99')).toBe(true);
    expect(r.breakdown!.netProfit.gte(5)).toBe(true);
  });
  it('reports impossible targets', () => {
    expect(solveUnitPrice({ base, target: { kind: 'margin', percent: 100 } }).achievable).toBe(false);
    const absurd = { ...base, feeRules: [{ ...rules[0]!, percent: '100' }] };
    expect(solveUnitPrice({ base: absurd, target: { kind: 'profit', amount: 1 }, maxPrice: 10000 }).achievable).toBe(false);
  });
});
