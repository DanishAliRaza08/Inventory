import { describe, expect, it } from 'vitest';
import { FeeContext, FeeRule, estimateFees } from '../src';

const ctx = (over: Partial<FeeContext> = {}): FeeContext => ({
  marketplace: 'EBAY_UK', currency: 'GBP', unitPrice: '20.00', quantity: 1, shippingCharged: '5.00', taxAmount: '4.17',
  pricesIncludeTax: true, at: new Date('2026-05-01'), ...over,
});

describe('fee rules', () => {
  const generic: FeeRule = { id: 'g', name: 'Selling fee', marketplace: 'EBAY_UK', feeType: 'final_value', basis: 'order_total_incl_tax', currency: 'GBP', percent: '10', overrideGroup: 'fvf' };
  const category: FeeRule = { ...generic, id: 'c', name: 'Clothing selling fee', percent: '8', categoryIds: ['11450'] };
  const perOrder: FeeRule = { id: 'o', name: 'Per-order fee', marketplace: 'EBAY_UK', feeType: 'per_order', basis: 'per_order', currency: 'GBP', fixed: '0.30' };

  it('applies percentage on the configured basis plus fixed fees', () => {
    const lines = estimateFees([generic, perOrder], ctx());
    expect(lines.map((l) => [l.ruleId, l.amount.toFixed(2)])).toEqual([
      ['o', '0.30'],
      ['g', '2.50'],
    ]);
  });
  it('category-specific rule overrides the generic rule in the same group', () => {
    const lines = estimateFees([generic, category], ctx({ categoryId: '11450' }));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.ruleId).toBe('c');
    expect(lines[0]!.amount.toFixed(2)).toBe('2.00');
    // and does not apply to other categories
    expect(estimateFees([generic, category], ctx({ categoryId: '999' }))[0]!.ruleId).toBe('g');
  });
  it('supports progressive tiers, min and max caps', () => {
    const tiered: FeeRule = { id: 't', name: 'Tiered', marketplace: 'EBAY_UK', feeType: 'final_value', basis: 'item_price', currency: 'GBP', tiers: [{ upTo: 100, percent: 10 }, { percent: 2 }] };
    expect(estimateFees([tiered], ctx({ unitPrice: 150 }))[0]!.amount.toFixed(2)).toBe('11.00');
    const capped: FeeRule = { ...tiered, id: 'm', tiers: undefined, percent: 10, maxFee: 5, minFee: 1 };
    expect(estimateFees([capped], ctx({ unitPrice: 100 }))[0]!.amount.toFixed(2)).toBe('5.00');
    expect(estimateFees([capped], ctx({ unitPrice: 2 }))[0]!.amount.toFixed(2)).toBe('1.00');
  });
  it('respects effective dates and inactive rules', () => {
    const old: FeeRule = { ...generic, id: 'old', effectiveTo: '2026-04-01' };
    const inactive: FeeRule = { ...perOrder, active: false };
    expect(estimateFees([old, inactive], ctx())).toHaveLength(0);
  });
  it('excl-tax basis removes tax', () => {
    const r: FeeRule = { ...generic, basis: 'order_total_excl_tax', percent: '10' };
    expect(estimateFees([r], ctx())[0]!.amount.toFixed(2)).toBe('2.08');
  });
  it('rejects a rule in the wrong currency', () => {
    expect(() => estimateFees([{ ...generic, currency: 'USD' }], ctx())).toThrow(/configured in USD/);
  });
});
