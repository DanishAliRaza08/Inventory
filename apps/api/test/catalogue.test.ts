import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestContext, createProduct, setupApp } from './helpers';

let t: TestContext;
beforeAll(async () => {
  t = await setupApp();
});
afterAll(() => t.close());

describe('products & SKUs', () => {
  it('creates a product with a permanent internal ID and variants', async () => {
    const owner = await t.as('owner');
    const p = await createProduct(owner, {
      variants: [
        { sku: 'FR-20001-10', size: '10', colour: 'Red' },
        { sku: 'FR-20001-12', size: '12', colour: 'Red', barcode: '5012345678900' },
      ],
    });
    expect(p.code).toMatch(/^FRP-\d{6}$/);
    expect(p.variants).toHaveLength(2);
    const list = await owner.get('/api/products?search=FR-20001-12');
    expect(list.body.items.map((x: { id: string }) => x.id)).toContain(p.id);
    const byCode = await owner.get(`/api/products?search=${p.code}`);
    expect(byCode.body.total).toBe(1);
  });

  it('filters and searches the product list by every identifier and by stock state', async () => {
    const owner = await t.as('owner');
    const sup = await owner.post('/api/suppliers', { name: 'Filter Test Supplier', type: 'MANUAL', shipsFromCountry: 'GB' });
    const drop = await createProduct(owner, { title: 'Filterable 100% Silk Scarf', fulfilmentModel: 'DROPSHIP', variants: [{ sku: 'FLT-SCARF-1', barcode: '4006381333931' }] });
    const phys = await createProduct(owner, { title: 'Filterable Wool Hat', fulfilmentModel: 'PHYSICAL', variants: [{ sku: 'FLT-HAT-1', initialStock: 0 }] });
    await owner.post(`/api/variants/${drop.variants[0].id}/suppliers`, { supplierId: sup.body.id, supplierSku: 'SUP-ABC-9', supplierProductId: '998877', currentPrice: '3.00', currency: 'GBP' });
    await owner.post('/api/variants/sku-aliases', { items: [{ variantId: phys.variants[0].id, type: 'LEGACY', alias: 'OLD-HAT-7' }] });
    const ids = async (qs: string) => ((await owner.get(`/api/products?${qs}`)).body.items as Array<{ id: string }>).map((x) => x.id);
    expect(await ids('search=filterable')).toEqual(expect.arrayContaining([drop.id, phys.id])); // title, case-insensitive
    expect(await ids('search=flt-scarf')).toEqual([drop.id]); // partial SKU
    expect(await ids('search=4006381333931')).toEqual([drop.id]); // barcode
    expect(await ids('search=old-hat-7')).toEqual([phys.id]); // alias
    expect(await ids('search=SUP-ABC-9')).toEqual([drop.id]); // supplier SKU
    expect(await ids('search=998877')).toEqual([drop.id]); // supplier product id
    expect(await ids(`search=${encodeURIComponent('100%')}`)).toEqual([drop.id]); // % is literal, not a wildcard
    expect(await ids('search=Filterable&fulfilmentModel=PHYSICAL')).toEqual([phys.id]);
    expect(await ids(`search=Filterable&supplierId=${sup.body.id}`)).toEqual([drop.id]);
    // Physical with 0 units and dropship with an unknown-status supplier: hat is out, scarf is in.
    expect(await ids('search=Filterable&stock=out')).toEqual([phys.id]);
    expect(await ids('search=Filterable&stock=in')).toEqual([drop.id]);
    const titleSorted = await ids('search=Filterable&sort=title');
    expect(titleSorted).toEqual([drop.id, phys.id]);
    const page2 = await owner.get('/api/products?search=Filterable&pageSize=1&page=2');
    expect(page2.body.total).toBe(2);
    expect(page2.body.items).toHaveLength(1);
  });

  it('enforces case-insensitive unique SKUs and valid barcodes', async () => {
    const owner = await t.as('owner');
    await createProduct(owner, { variants: [{ sku: 'DUP-1' }] });
    const res = await owner.post('/api/products', { title: 'x', variants: [{ sku: 'dup-1' }] });
    expect(res.status).toBe(409);
    const bad = await owner.post('/api/products', { title: 'x', variants: [{ sku: 'GT-1', barcode: '5012345678901' }] });
    expect(bad.body.code).toBe('GTIN_INVALID');
  });

  it('global search respects permissions', async () => {
    const viewer = await t.as('viewer');
    const r = await viewer.get('/api/search?q=FR-20001');
    expect(r.body.variants.length).toBeGreaterThan(0);
    expect(r.body.suppliers).toEqual([]); // viewer has no suppliers.read
  });

  it('bulk updates and records an audit entry', async () => {
    const owner = await t.as('owner');
    const a = await createProduct(owner);
    const b = await createProduct(owner);
    const r = await owner.post('/api/products/bulk-update', { productIds: [a.id, b.id], patch: { category: 'Summer' } });
    expect(r.body.updated).toBe(2);
    const audit = await owner.get('/api/audit-logs?action=product.bulk_update');
    expect(audit.body.total).toBeGreaterThan(0);
  });

  it('the audit log cannot be altered', async () => {
    await expect(t.prisma.$executeRawUnsafe(`UPDATE audit_logs SET action = 'x'`)).rejects.toThrow(/append-only/);
    await expect(t.prisma.$executeRawUnsafe(`DELETE FROM audit_logs`)).rejects.toThrow(/append-only/);
  });
});

describe('effective-dated costs', () => {
  it('preserves history: a new cost closes the old one and backdating is refused', async () => {
    const owner = await t.as('owner');
    const p = await createProduct(owner);
    const vid = p.variants[0].id;
    const r = await owner.post(`/api/variants/${vid}/costs`, { currency: 'GBP', supplierPrice: '9.00', supplierShipping: '2.00' });
    expect(r.status).toBe(201);
    const hist = await owner.get(`/api/variants/${vid}/costs`);
    expect(hist.body).toHaveLength(2);
    const [current, old] = hist.body;
    expect(current.effectiveTo).toBeNull();
    expect(old.effectiveTo).toBe(current.effectiveFrom);
    expect(old.supplierPrice).toBe('8');
    const back = await owner.post(`/api/variants/${vid}/costs`, { currency: 'GBP', supplierPrice: '1.00', effectiveFrom: '2020-01-01' });
    expect(back.body.code).toBe('COST_BACKDATED');
  });

  it('database allows only one open cost per SKU', async () => {
    const owner = await t.as('owner');
    const p = await createProduct(owner);
    await expect(
      t.prisma.costRecord.create({ data: { variantId: p.variants[0].id, effectiveFrom: new Date(), currency: 'GBP', supplierPrice: '1' } }),
    ).rejects.toThrow();
  });

  it('supplier price change keeps price history, creates a new cost and raises an alert', async () => {
    const owner = await t.as('owner');
    const p = await createProduct(owner, { variants: [{ sku: 'SUP-PRICE-1', initialCost: { currency: 'USD', supplierPrice: '10.00', supplierShipping: '2.00', packaging: '0.30' } }] });
    const vid = p.variants[0].id;
    const sup = await owner.post('/api/suppliers', { name: 'AliExpress Store 1', type: 'ALIEXPRESS', defaultCurrency: 'USD' });
    const sp = await owner.post(`/api/variants/${vid}/suppliers`, { supplierId: sup.body.id, currentPrice: '10.00', shippingCost: '2.00', currency: 'USD', url: 'https://example.com/item/1' });
    expect(sp.status).toBe(201);
    const up = await owner.post(`/api/supplier-products/${sp.body.id}/price`, { currentPrice: '11.50', source: 'manual-check' });
    expect(up.status).toBe(201);
    expect(up.body.costRecord.supplierPrice).toBe('11.5');
    expect(up.body.costRecord.packaging).toBe('0.3'); // carried forward
    const hist = await owner.get(`/api/supplier-products/${sp.body.id}/price-history`);
    expect(hist.body.map((h: { price: string }) => h.price)).toEqual(['11.5', '10']);
    const notes = await owner.get('/api/notifications');
    expect(notes.body.some((n: { type: string }) => n.type === 'SUPPLIER_PRICE_INCREASE')).toBe(true);
  });
});

describe('inventory', () => {
  it('applies movements atomically, idempotently and never goes negative', async () => {
    const owner = await t.as('owner');
    const p = await createProduct(owner, { fulfilmentModel: 'PHYSICAL', variants: [{ sku: 'PHYS-1', initialStock: 5 }] });
    const vid = p.variants[0].id;
    const reserve = (key: string, qty = 1) => owner.post(`/api/variants/${vid}/inventory/movements`, { type: 'RESERVE', quantity: qty, idempotencyKey: key });
    expect((await reserve('order-1')).status).toBe(201);
    const dup = await reserve('order-1');
    expect(dup.body.duplicate).toBe(true);
    const rec = await t.prisma.inventoryRecord.findFirstOrThrow({ where: { variantId: vid } });
    expect([rec.available, rec.reserved]).toEqual([4, 1]);
    expect((await reserve('order-2', 10)).body.code).toBe('INSUFFICIENT_STOCK');
  });

  it('concurrent reservations cannot oversell', async () => {
    const owner = await t.as('owner');
    const p = await createProduct(owner, { fulfilmentModel: 'PHYSICAL', variants: [{ sku: 'PHYS-RACE', initialStock: 3 }] });
    const vid = p.variants[0].id;
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => owner.post(`/api/variants/${vid}/inventory/movements`, { type: 'RESERVE', quantity: 1, idempotencyKey: `race-${i}` })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    const rec = await t.prisma.inventoryRecord.findFirstOrThrow({ where: { variantId: vid } });
    expect([rec.available, rec.reserved]).toEqual([0, 3]);
  });

  it('keeps supplier availability separate from owned stock for dropship SKUs', async () => {
    const owner = await t.as('owner');
    const p = await createProduct(owner, { variants: [{ sku: 'DROP-1' }] });
    const vid = p.variants[0].id;
    const sup = await owner.post('/api/suppliers', { name: 'CJ Test', type: 'CJ_DROPSHIPPING' });
    const sp = await owner.post(`/api/variants/${vid}/suppliers`, { supplierId: sup.body.id, currentPrice: '5', currency: 'USD' });
    await owner.post(`/api/supplier-products/${sp.body.id}/stock`, { stockStatus: 'IN_STOCK', reportedQuantity: 1000, source: 'cj-api' });
    const a = await owner.get(`/api/variants/${vid}/inventory`);
    expect(a.body.model).toBe('DROPSHIP');
    expect(a.body.availableToSell).toBe(10); // capped buffer, not 1000
    expect(a.body.record.available).toBe(0); // owned stock untouched
  });

  it('stock count records an explicit adjustment', async () => {
    const owner = await t.as('owner');
    const p = await createProduct(owner, { fulfilmentModel: 'PHYSICAL', variants: [{ sku: 'PHYS-COUNT', initialStock: 10 }] });
    const vid = p.variants[0].id;
    await owner.post(`/api/variants/${vid}/inventory/count`, { counted: 7, reason: 'cycle count' });
    const m = await owner.get(`/api/variants/${vid}/inventory/movements`);
    expect(m.body[0]).toMatchObject({ type: 'ADJUST_DOWN', quantity: 3 });
  });
});
