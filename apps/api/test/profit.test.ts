import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestContext, createProduct, setupApp } from './helpers';

let t: TestContext;
beforeAll(async () => {
  t = await setupApp({ demo: false });
  const owner = await t.as('owner');
  await owner.post('/api/fee-rules', { name: 'Selling fee', marketplace: 'EBAY_UK', feeType: 'final_value', basis: 'order_total_incl_tax', currency: 'GBP', percent: '12', effectiveFrom: '2020-01-01' });
  await owner.post('/api/fee-rules', { name: 'Per order', marketplace: 'EBAY_UK', feeType: 'per_order', basis: 'per_order', currency: 'GBP', fixed: '0.30', effectiveFrom: '2020-01-01' });
});
afterAll(() => t.close());

describe('profit calculator API', () => {
  it('reproduces the demonstration example', async () => {
    const r = await (await t.as('viewer')).post('/api/profit/simple', { netSalesRevenue: '25', productCost: '8', supplierShipping: '2', marketplaceFees: '3', otherExpenses: '1' });
    expect(r.body).toMatchObject({ netProfit: '11', netMarginPercent: '44', demonstration: true });
  });

  it('calculates a SKU on eBay UK with VAT excluded from revenue and configured fees', async () => {
    const owner = await t.as('owner');
    const p = await createProduct(owner);
    const r = await owner.post('/api/profit/calculate', { marketplace: 'EBAY_UK', variantId: p.variants[0].id, unitPrice: '24.00' });
    expect(r.status).toBe(200);
    const b = r.body.breakdown;
    expect(b.taxCollected).toBe('4');
    expect(b.netRevenue).toBe('20');
    expect(b.marketplaceFees).toBe('3.18'); // 12% of 24.00 + 0.30
    expect(b.totalProductCost).toBe('10');
    expect(b.netProfit).toBe('6.82');
    expect(b.status).toBe('estimated');
    expect(Number(r.body.minimumProfitablePrice)).toBeGreaterThan(12);
  });

  it('refuses to convert a USD cost without an exchange rate, then uses the stored rate', async () => {
    const owner = await t.as('owner');
    const p = await createProduct(owner, { variants: [{ sku: 'USD-COST-1', initialCost: { currency: 'USD', supplierPrice: '10.00' } }] });
    const no = await owner.post('/api/profit/calculate', { marketplace: 'EBAY_UK', variantId: p.variants[0].id, unitPrice: '24.00' });
    expect(no.status).toBe(422);
    expect(no.body.code).toBe('MissingFxRateError');
    const fin = await t.as('finance_manager');
    expect((await fin.post('/api/fx-rates', { base: 'USD', quote: 'GBP', rate: '0.80', asOf: '2026-01-01' })).status).toBe(201);
    const ok = await owner.post('/api/profit/calculate', { marketplace: 'EBAY_UK', variantId: p.variants[0].id, unitPrice: '24.00' });
    expect(ok.body.breakdown.productCost).toBe('8');
    expect(ok.body.breakdown.fxConversions[0]).toMatchObject({ from: 'USD', to: 'GBP', rate: '0.8' });
  });

  it('reverse calculator returns the lowest price meeting a target margin', async () => {
    const owner = await t.as('owner');
    const p = await createProduct(owner);
    const r = await owner.post('/api/profit/reverse-price', { marketplace: 'EBAY_UK', variantId: p.variants[0].id, target: { kind: 'margin', percent: '30' } });
    expect(r.body.achievable).toBe(true);
    expect(Number(r.body.breakdown.netMarginPercent)).toBeGreaterThanOrEqual(30);
  });

  it('flags low profit using configurable thresholds', async () => {
    const owner = await t.as('owner');
    const p = await createProduct(owner);
    const r = await owner.post('/api/profit/calculate', { marketplace: 'EBAY_UK', variantId: p.variants[0].id, unitPrice: '15.00' });
    expect(r.body.alerts.map((a: { code: string }) => a.code)).toEqual(expect.arrayContaining(['LOW_PROFIT']));
    await owner.put('/api/settings/alerts.min_profit', { value: '0.10' });
    const r2 = await owner.post('/api/profit/calculate', { marketplace: 'EBAY_UK', variantId: p.variants[0].id, unitPrice: '15.00' });
    expect(r2.body.alerts.map((a: { code: string }) => a.code)).not.toContain('LOW_PROFIT');
  });

  it('only finance roles can see expenses; expenses are recorded', async () => {
    const fin = await t.as('finance_manager');
    const e = await fin.post('/api/expenses', { date: '2026-05-01', category: 'SOFTWARE', description: 'Accounting software', amount: '30.00', currency: 'GBP' });
    expect(e.status).toBe(201);
    expect((await (await t.as('listing_manager')).get('/api/expenses')).status).toBe(403);
  });

  it('applies the UK low-value import VAT rule automatically from the supplier origin', async () => {
    const owner = await t.as('owner');
    const calc = async (variantId: string, unitPrice = '24.00') =>
      (await owner.post('/api/profit/calculate', { marketplace: 'EBAY_UK', variantId, unitPrice })).body.assumptions.tax;

    // Overseas supplier, £20 goods excl. VAT -> marketplace is the deemed supplier.
    const cn = await owner.post('/api/suppliers', { name: 'AliExpress CN', type: 'ALIEXPRESS', shipsFromCountry: 'cn' });
    expect(cn.body.shipsFromCountry).toBe('CN');
    const p = await createProduct(owner);
    const sp = await owner.post(`/api/variants/${p.variants[0].id}/suppliers`, { supplierId: cn.body.id, currentPrice: '8', currency: 'GBP' });
    const t1 = await calc(p.variants[0].id);
    expect(t1.taxTreatment).toBe('marketplace_collected');
    expect(t1.taxTreatmentReason).toMatch(/CN/);
    // Above £135 excl. VAT the seller accounts for VAT.
    expect((await calc(p.variants[0].id, '200.00')).taxTreatment).toBe('seller_liable');

    // A UK-warehouse override on the supplier SKU, and physical stock, are UK sales.
    await t.prisma.supplierProduct.update({ where: { id: sp.body.id }, data: { shipsFromCountry: 'GB' } });
    expect((await calc(p.variants[0].id)).taxTreatment).toBe('seller_liable');
    const phys = await createProduct(owner, { fulfilmentModel: 'PHYSICAL', variants: [{ sku: 'VAT-PHYS', initialCost: { currency: 'GBP', supplierPrice: '8' } }] });
    expect((await calc(phys.variants[0].id)).taxTreatment).toBe('seller_liable');

    // Unknown origin is flagged; the rule can be switched off in settings.
    const unknown = await createProduct(owner);
    expect((await calc(unknown.variants[0].id)).taxTreatmentReason).toMatch(/unknown/);
    await owner.put('/api/settings/finance.auto_low_value_import_vat', { value: false });
    await t.prisma.supplierProduct.update({ where: { id: sp.body.id }, data: { shipsFromCountry: 'CN' } });
    expect((await calc(p.variants[0].id)).taxTreatment).toBe('seller_liable');
    await owner.put('/api/settings/finance.auto_low_value_import_vat', { value: true });
  });
});
