import { describe, expect, it } from 'vitest';
import { Decimal, OrderLineProfitInput, UkImportTaxRule, calculateOrderLineProfit, resolveUkImportTax } from '../src';

const rule = (over: Partial<UkImportTaxRule> = {}): UkImportTaxRule => ({
  kind: 'uk_low_value_import', shipsFromCountry: 'CN', sellerVatRegistered: true, thresholdGbp: 135, saleToGbpRate: 1, ...over,
});

describe('UK low-value import VAT rule', () => {
  it('overseas goods at or below £135 → marketplace accounts for VAT', () => {
    expect(resolveUkImportTax(rule(), new Decimal(135)).treatment).toBe('marketplace_collected');
    expect(resolveUkImportTax(rule(), new Decimal(20)).reason).toMatch(/deemed supplier/);
  });
  it('overseas goods above £135 → seller position', () => {
    expect(resolveUkImportTax(rule(), new Decimal('135.01')).treatment).toBe('seller_liable');
    expect(resolveUkImportTax(rule({ sellerVatRegistered: false }), new Decimal(200)).treatment).toBe('not_registered');
  });
  it('UK stock and unknown origin → seller position, unknown is flagged', () => {
    expect(resolveUkImportTax(rule({ shipsFromCountry: 'gb' }), new Decimal(10)).treatment).toBe('seller_liable');
    const u = resolveUkImportTax(rule({ shipsFromCountry: null }), new Decimal(10));
    expect(u.treatment).toBe('seller_liable');
    expect(u.reason).toMatch(/unknown/);
  });
  it('converts the consignment value into GBP before testing the threshold', () => {
    expect(resolveUkImportTax(rule({ saleToGbpRate: '0.8' }), new Decimal(160)).treatment).toBe('marketplace_collected'); // $160 = £128
    expect(resolveUkImportTax(rule({ saleToGbpRate: '0.8' }), new Decimal(170)).treatment).toBe('seller_liable'); // $170 = £136
  });
});

describe('profit engine applies the rule per order line', () => {
  const base: OrderLineProfitInput = {
    marketplace: 'EBAY_UK', saleCurrency: 'GBP', soldAt: new Date('2026-05-01'), quantity: 1, unitPrice: '30.00', pricesIncludeTax: true,
    taxRatePercent: 20, taxTreatment: rule(), cost: { effectiveFrom: '2026-01-01', currency: 'GBP', supplierPrice: '8' },
  };
  it('records the resolved treatment and reason; VAT is still never revenue', () => {
    const b = calculateOrderLineProfit(base);
    expect(b.taxTreatment).toBe('marketplace_collected');
    expect(b.taxTreatmentReason).toMatch(/£25.00/); // value excl. VAT
    expect(b.netRevenue.toFixed(2)).toBe('25.00');
  });
  it('uses goods value excluding shipping and VAT for the threshold', () => {
    const b = calculateOrderLineProfit({ ...base, quantity: 6, shippingCharged: '50' }); // goods 180 incl VAT = 150 excl
    expect(b.taxTreatment).toBe('seller_liable');
    const c = calculateOrderLineProfit({ ...base, quantity: 5, shippingCharged: '50' }); // 150 incl = 125 excl
    expect(c.taxTreatment).toBe('marketplace_collected');
  });
  it('fixed treatments still work', () => {
    expect(calculateOrderLineProfit({ ...base, taxTreatment: 'seller_liable' }).taxTreatmentReason).toBe('Configured tax treatment.');
  });
});
