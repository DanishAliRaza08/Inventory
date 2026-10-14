import { Server } from 'http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockServer } from '../src/mock/mock-server';
import { PublicationService } from '../src/listings/publication.service';
import { Agent, TestContext, createProduct, setupApp } from './helpers';

const API_PORT = 4198;
const MOCK_PORT = 4199;
const ENV = { MOCK_MARKETPLACES: 'true', MOCK_BASE_URL: `http://localhost:${MOCK_PORT}`, PUBLIC_BASE_URL: `http://localhost:${API_PORT}`, WEB_ORIGIN: 'http://localhost:3999' };
const saved: Record<string, string | undefined> = {};

let t: TestContext;
let mock: Server;
let owner: Agent;
let approver: Agent;
const acc: Record<string, string> = {};

function png(): Buffer {
  // 1000x1000 grey PNG, generated once
  const { deflateSync } = require('zlib') as typeof import('zlib');
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const w = 1000, h = 1000, ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h, 128); for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Follow the OAuth redirect chain: our connect URL → mock consent → our callback → web app. */
async function oauthConnect(startPath: string) {
  const r = await owner.get(startPath);
  expect(r.status).toBe(200);
  const consent = await fetch(r.body.url, { redirect: 'manual' });
  expect(consent.status).toBe(302);
  const cb = await fetch(consent.headers.get('location')!, { redirect: 'manual' });
  expect(cb.status).toBe(302);
  return cb.headers.get('location')!;
}

async function drainConfirmations() {
  const pub = t.app.get(PublicationService);
  for (let i = 0; i < 4; i++) {
    await t.prisma.listingPublicationJob.updateMany({ where: { status: 'QUEUED' }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await pub.sweep();
  }
}

async function publish(accountId: string, variantId: string, content: Record<string, unknown>, price = '24.99') {
  const d = await (await t.as('listing_manager')).post('/api/listings', { variantId, accountId, price, content });
  expect(d.status).toBe(201);
  const id = d.body.listingId;
  const sub = await (await t.as('listing_manager')).post(`/api/listings/${id}/submit`);
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  expect((await approver.post(`/api/listings/${id}/approve`)).status).toBe(200);
  expect((await approver.post(`/api/listings/${id}/publish`)).status).toBe(202);
  return id;
}

const baseContent = { condition: 'NEW', dispatchTimeDays: 2, shippingPolicyId: 'ship-1', returnPolicyId: 'ret-1', verifiedAttributes: ['Size', 'Colour', 'Material'] };

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  mock = await startMockServer(MOCK_PORT);
  t = await setupApp({ demo: false });
  await t.app.listen(API_PORT);
  owner = await t.as('owner');
  approver = await t.as('listing_approver');
  for (const a of (await owner.get('/api/integrations/accounts')).body) acc[a.marketplace] = a.id;
  await owner.put('/api/settings/finance.vat_registered', { value: true });
  // Catalogue matching the SKUs that already exist on the mock marketplaces.
  const sup = await owner.post('/api/suppliers', { name: 'AliExpress Store (mock)', type: 'ALIEXPRESS', shipsFromCountry: 'CN', defaultCurrency: 'USD' });
  const cj = await owner.post('/api/suppliers', { name: 'CJ Dropshipping (mock)', type: 'CJ_DROPSHIPPING', shipsFromCountry: 'CN' });
  acc.aeSupplier = sup.body.id;
  acc.cjSupplier = cj.body.id;
  await createProduct(owner, { title: 'Floral Midi Dress', fulfilmentModel: 'PHYSICAL', variants: [{ sku: 'FR-10001-10', size: '10', colour: 'Blue', initialStock: 20, initialCost: { currency: 'GBP', supplierPrice: '7.00', supplierShipping: '1.00' } }, { sku: 'FR-10001-12', size: '12', colour: 'Blue', initialStock: 20, initialCost: { currency: 'GBP', supplierPrice: '7.00', supplierShipping: '1.00' } }] });
  const drop1 = await createProduct(owner, { title: 'Linen Shirt', fulfilmentModel: 'DROPSHIP', variants: [{ sku: 'FR-10002-M', size: 'M', colour: 'White', initialCost: { currency: 'GBP', supplierPrice: '5.00' } }] });
  const drop2 = await createProduct(owner, { title: 'Oversized Hoodie', fulfilmentModel: 'DROPSHIP', variants: [{ sku: 'FR-10003-L', size: 'L', colour: 'Black', initialCost: { currency: 'GBP', supplierPrice: '9.00' } }] });
  const ae = await owner.post(`/api/variants/${drop1.variants[0].id}/suppliers`, { supplierId: sup.body.id, supplierProductId: '1005001', supplierSku: '1005001-1', currentPrice: '5.00', currency: 'USD' });
  acc.aeSupplierProduct = ae.body.id;
  const cjp = await owner.post(`/api/variants/${drop2.variants[0].id}/suppliers`, { supplierId: cj.body.id, supplierSku: 'VID3003', currentPrice: '9.00', currency: 'USD' });
  acc.cjSupplierProduct = cjp.body.id;
  await owner.post('/api/fx-rates', { base: 'USD', quote: 'GBP', rate: '0.79', asOf: '2026-01-01' });
}, 120_000);

afterAll(async () => {
  await t.close();
  await new Promise((r) => mock.close(r));
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe('eBay UK via the Trading API (mock marketplace)', () => {
  it('connects with OAuth and stores encrypted tokens', async () => {
    const back = await oauthConnect(`/api/integrations/accounts/${acc.EBAY_UK}/connect`);
    expect(back).toBe('http://localhost:3999/integrations?connected=ebay');
    const a = await t.prisma.marketplaceAccount.findUniqueOrThrow({ where: { id: acc.EBAY_UK }, include: { credential: true } });
    expect(a.status).toBe('CONNECTED');
    expect(a.credential!.ciphertext).not.toContain('ebay-access');
    expect((await owner.post(`/api/integrations/accounts/${acc.EBAY_UK}/test`)).body.ok).toBe(true);
  });

  it('adopts existing Seller Hub listings by SKU without migrating them', async () => {
    const r = await owner.post(`/api/integrations/accounts/${acc.EBAY_UK}/adopt-listings`);
    expect(r.body).toMatchObject({ ok: true, found: 4, adopted: 4 });
    const l = await t.prisma.marketplaceListing.findFirstOrThrow({ where: { accountId: acc.EBAY_UK, sku: 'FR-10001-10' } });
    expect(l.status).toBe('ACTIVE');
    expect(l.externalListingId).toMatch(/^1100/);
  });

  it('publishes a new listing (Verify + AddFixedPriceItem) and refuses without a location', async () => {
    const p = await createProduct(owner, { title: 'Satin Slip Dress', variants: [{ sku: 'EB-NEW-1', size: '10', colour: 'Green', material: 'Satin', initialCost: { currency: 'GBP', supplierPrice: '6.00' } }] });
    await owner.upload(`/api/products/${p.id}/images`, 'file', png(), 'a.png');
    const noLocation = await publish(acc.EBAY_UK, p.variants[0].id, { ...baseContent, categoryId: '63861' });
    let l = await t.prisma.marketplaceListing.findUniqueOrThrow({ where: { id: noLocation } });
    expect(l.status).toBe('PUBLICATION_FAILED');
    expect(l.lastError).toMatch(/postcode/);

    await owner.patch(`/api/integrations/accounts/${acc.EBAY_UK}/settings`, { postcode: 'LS1 1AA', country: 'GB', paymentPolicyId: 'pay-1' });
    expect((await approver.post(`/api/listings/${noLocation}/retry`)).status).toBe(202);
    l = await t.prisma.marketplaceListing.findUniqueOrThrow({ where: { id: noLocation } });
    expect(l.status).toBe('ACTIVE');
    expect(l.externalListingId).toMatch(/^12\d{10}$/);
    const ops = await t.prisma.marketplaceOperation.findMany({ where: { entityId: noLocation }, orderBy: { createdAt: 'asc' } });
    expect(ops.map((o) => o.status)).toEqual(['FAILED_PERMANENT', 'SUCCEEDED']);
  });

  it('loads the category’s required item specifics from eBay', async () => {
    const p = await createProduct(owner, { variants: [{ sku: 'EB-ATTR-1', initialCost: { currency: 'GBP', supplierPrice: '6' } }] });
    const d = await (await t.as('listing_manager')).post('/api/listings', { variantId: p.variants[0].id, accountId: acc.EBAY_UK, content: { categoryId: '63861' } });
    const r = await (await t.as('listing_manager')).post(`/api/listings/${d.body.listingId}/category-attributes`);
    expect(r.body.required).toEqual(['Brand', 'Size', 'Colour', 'Department']);
  });

  it('imports orders (UK site only), reserves stock and encrypts the buyer address', async () => {
    const r = await owner.post(`/api/integrations/accounts/${acc.EBAY_UK}/sync/orders`);
    expect(r.body.ok).toBe(true);
    expect(r.body.created).toBe(6);
    const orders = await t.prisma.order.findMany({ where: { accountId: acc.EBAY_UK }, include: { lines: { include: { profit: { where: { isCurrent: true } } } }, customer: true } });
    expect(orders.every((o) => o.currency === 'GBP')).toBe(true);
    expect(orders.every((o) => o.customer?.name && !o.customer.name.includes(' '))).toBe(true); // sealed ciphertext
    expect(orders.flatMap((o) => o.lines).every((l) => l.variantId && l.profit.length === 1)).toBe(true);
    const physical = await t.prisma.inventoryRecord.findFirstOrThrow({ where: { variant: { sku: 'FR-10001-10' } } });
    expect(physical.committed + physical.available).toBe(20);
    // Second sync is idempotent.
    expect((await owner.post(`/api/integrations/accounts/${acc.EBAY_UK}/sync/orders`)).body.created).toBe(0);
  });

  it('marks an order dispatched only after eBay accepts the tracking', async () => {
    const order = await t.prisma.order.findFirstOrThrow({ where: { accountId: acc.EBAY_UK, status: 'AWAITING_DISPATCH', lines: { some: { sku: { startsWith: 'FR-10001' } } } } });
    const r = await (await t.as('order_manager')).post(`/api/orders/${order.id}/shipments`, { carrier: 'Royal Mail', trackingNumber: 'RM123456785GB', labelCost: '3.20' });
    expect(r.body.status).toBe('DISPATCHED');
    const after = await t.prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { fulfilments: { include: { shipments: true } } } });
    expect(after.fulfilments[0]!.confirmedAt).not.toBeNull();
    expect(after.fulfilments[0]!.shipments[0]!.pushedToMarketplaceAt).not.toBeNull();
  });

  it('reconciles actual fees, refunds and payouts into confirmed profit', async () => {
    const r = await owner.post(`/api/integrations/accounts/${acc.EBAY_UK}/sync/finance`);
    expect(r.body.ok).toBe(true);
    expect(r.body.fees).toBeGreaterThan(0);
    const calcs = await t.prisma.profitCalculation.findMany({ where: { isCurrent: true, orderLine: { order: { accountId: acc.EBAY_UK } } } });
    expect(calcs.every((c) => c.status !== 'estimated')).toBe(true);
    expect(calcs.some((c) => c.status === 'confirmed')).toBe(true);
    expect((await owner.post(`/api/integrations/accounts/${acc.EBAY_UK}/sync/finance`)).body.fees).toBe(0); // idempotent
  });

  it('pushes stock levels and approved price changes to the live listing', async () => {
    const l = await t.prisma.marketplaceListing.findFirstOrThrow({ where: { accountId: acc.EBAY_UK, sku: 'FR-10001-12' } });
    await owner.put('/api/settings/controls.inventory_sync_enabled', { value: true });
    await owner.patch(`/api/variants/${l.variantId}/inventory/settings`, { policy: 'AUTO_SYNC', safetyStock: 2 });
    await owner.post(`/api/integrations/accounts/${acc.EBAY_UK}/sync/inventory`);
    const state = (await (await fetch(`http://localhost:${MOCK_PORT}/mock/state`)).json()) as any;
    const onEbay = state.EBAY_UK.find((x: { sku: string }) => x.sku === 'FR-10001-12');
    const rec = await t.prisma.inventoryRecord.findFirstOrThrow({ where: { variantId: l.variantId } });
    expect(onEbay.quantity).toBe(rec.available - 2);
    const rp = await approver.post(`/api/listings/${l.id}/reprice`, { price: '27.49', note: 'test' });
    expect(rp.body.queued).toBe(true);
    const after = (await (await fetch(`http://localhost:${MOCK_PORT}/mock/state`)).json()) as any;
    expect(after.EBAY_UK.find((x: { sku: string }) => x.sku === 'FR-10001-12').price).toBe(27.49);
    expect((await t.prisma.marketplaceListing.findUniqueOrThrow({ where: { id: l.id } })).price!.toString()).toBe('27.49');
  });
});

describe('Amazon UK via the Selling Partner API (mock marketplace)', () => {
  it('connects with a self-authorised refresh token', async () => {
    const r = await owner.post(`/api/integrations/accounts/${acc.AMAZON_UK}/credentials`, { refreshToken: 'Atzr|mock-refresh-token', sellerId: 'AMOCKSELLER1' });
    expect(r.body.ok).toBe(true);
  });

  it('submits a listing, keeps it Publishing until Amazon reports it buyable, then marks it Active', async () => {
    const p = await createProduct(owner, { title: 'Wrap Dress', brand: 'Rockstar', variants: [{ sku: 'AMZ-NEW-1', size: '12', colour: 'Red', barcode: '5012345678900', initialCost: { currency: 'GBP', supplierPrice: '6.00' } }] });
    await owner.upload(`/api/products/${p.id}/images`, 'file', png(), 'a.png');
    const id = await publish(acc.AMAZON_UK, p.variants[0].id, { ...baseContent, categoryId: 'DRESS', productType: 'DRESS', bulletPoints: ['Wrap style'] });
    expect((await t.prisma.marketplaceListing.findUniqueOrThrow({ where: { id } })).status).toBe('PUBLISHING');
    await drainConfirmations();
    const l = await t.prisma.marketplaceListing.findUniqueOrThrow({ where: { id } });
    expect(l.status).toBe('ACTIVE');
    expect(l.externalListingId).toBe('AMZ-NEW-1');
  });

  it('imports merchant-fulfilled orders with addresses via a Restricted Data Token, then fees and settlements', async () => {
    const r = await owner.post(`/api/integrations/accounts/${acc.AMAZON_UK}/sync/orders`);
    expect(r.body.created).toBe(6);
    const o = await t.prisma.order.findFirstOrThrow({ where: { accountId: acc.AMAZON_UK } });
    const c = await (await t.as('order_manager')).get(`/api/orders/${o.id}/customer`);
    expect(c.body.postcode).toBeTruthy();
    const purge = await t.prisma.orderCustomer.findUniqueOrThrow({ where: { orderId: o.id } });
    expect(purge.purgeAfter!.getTime() - o.orderedAt.getTime()).toBeLessThanOrEqual(30 * 86_400_000 + 1000);
    const f = await owner.post(`/api/integrations/accounts/${acc.AMAZON_UK}/sync/finance`);
    expect(f.body.fees).toBeGreaterThan(0);
    const fee = await t.prisma.actualFee.findFirstOrThrow({ where: { marketplace: 'AMAZON_UK', name: 'Commission' } });
    expect(Number(fee.amount)).toBeGreaterThan(0); // Amazon's negative charge stored as a positive cost
  });

  it('adopts existing offers from the merchant listings report', async () => {
    const r = await owner.post(`/api/integrations/accounts/${acc.AMAZON_UK}/adopt-listings`);
    expect(r.body.ok).toBe(true);
    expect(r.body.adopted + r.body.alreadyLinked).toBe(r.body.found);
  });
});

describe('TikTok Shop UK (mock marketplace verifying request signatures)', () => {
  it('connects with OAuth and finds the UK shop cipher', async () => {
    await oauthConnect(`/api/integrations/accounts/${acc.TIKTOK_UK}/connect`);
    const a = await t.prisma.marketplaceAccount.findUniqueOrThrow({ where: { id: acc.TIKTOK_UK } });
    expect(a.status).toBe('CONNECTED');
    expect(a.externalAccountId).toBe('7000000001');
    await owner.patch(`/api/integrations/accounts/${acc.TIKTOK_UK}/settings`, { warehouseId: 'WH-1', shippingProviderIds: { 'Royal Mail': '6617675021119438597' } });
  });

  it('uploads images from signed URLs, creates the product and waits for TikTok’s audit', async () => {
    const p = await createProduct(owner, { title: 'Pleated Tennis Skirt for Women', variants: [{ sku: 'TT-NEW-1', size: 'S', colour: 'White', material: 'Polyester', initialCost: { currency: 'GBP', supplierPrice: '5.00' } }] });
    await owner.upload(`/api/products/${p.id}/images`, 'file', png(), 'a.png');
    const id = await publish(acc.TIKTOK_UK, p.variants[0].id, { ...baseContent, categoryId: '601152', title: 'Pleated Tennis Skirt for Women - White - Size S', attributes: { Material: 'Polyester', Size: 'S', Colour: 'White' } }, '18.99');
    expect((await t.prisma.marketplaceListing.findUniqueOrThrow({ where: { id } })).status).toBe('PUBLISHING');
    await drainConfirmations();
    const l = await t.prisma.marketplaceListing.findUniqueOrThrow({ where: { id } });
    expect(l.status).toBe('ACTIVE');
    expect(l.externalOfferId).toMatch(/^1731/);
  });

  it('shows the audit failure reason when TikTok rejects a product', async () => {
    const p = await createProduct(owner, { title: 'Skirt', variants: [{ sku: 'TT-FAIL-1', initialCost: { currency: 'GBP', supplierPrice: '5.00' } }] });
    await owner.upload(`/api/products/${p.id}/images`, 'file', png(), 'a.png');
    const id = await publish(acc.TIKTOK_UK, p.variants[0].id, { ...baseContent, categoryId: '601152', title: 'Pleated Tennis Skirt [audit-fail] for Women', verifiedAttributes: [], attributes: {} }, '18.99');
    await drainConfirmations();
    const l = await t.prisma.marketplaceListing.findUniqueOrThrow({ where: { id } });
    expect(l.status).toBe('PUBLICATION_FAILED');
    expect(l.lastError).toMatch(/Prohibited wording/);
  });

  it('imports orders, ships packages with tracking and reconciles statements', async () => {
    expect((await owner.post(`/api/integrations/accounts/${acc.TIKTOK_UK}/sync/orders`)).body.created).toBe(6);
    const o = await t.prisma.order.findFirstOrThrow({ where: { accountId: acc.TIKTOK_UK, status: 'AWAITING_DISPATCH' } });
    expect((await (await t.as('order_manager')).post(`/api/orders/${o.id}/shipments`, { carrier: 'Royal Mail', trackingNumber: 'RM999999995GB' })).body.status).toBe('DISPATCHED');
    const unmapped = await t.prisma.order.findFirstOrThrow({ where: { accountId: acc.TIKTOK_UK, status: 'AWAITING_DISPATCH' } });
    const bad = await (await t.as('order_manager')).post(`/api/orders/${unmapped.id}/shipments`, { carrier: 'Evri', trackingNumber: 'H00000000000001' });
    expect(bad.body.code).toBe('TRACKING_REJECTED');
    expect((await t.prisma.order.findUniqueOrThrow({ where: { id: unmapped.id } })).status).toBe('AWAITING_DISPATCH');
    const f = await owner.post(`/api/integrations/accounts/${acc.TIKTOK_UK}/sync/finance`);
    expect(f.body.fees).toBeGreaterThan(0);
    expect(f.body.settled).toBeGreaterThan(0);
  });
});

describe('Suppliers: AliExpress DS API and CJ (mock)', () => {
  it('connects AliExpress with OAuth and syncs price, stock and ships-from into history and costs', async () => {
    const back = await oauthConnect(`/api/integrations/suppliers/${acc.aeSupplier}/connect`);
    expect(back).toBe(`http://localhost:3999/suppliers/${acc.aeSupplier}?connected=1`);
    const r = await owner.post(`/api/integrations/supplier-products/${acc.aeSupplierProduct}/sync`);
    expect(r.body.ok).toBe(true);
    const sp = await t.prisma.supplierProduct.findUniqueOrThrow({ where: { id: acc.aeSupplierProduct }, include: { priceHistory: true } });
    expect(sp.stockSource).toBe('aliexpress-api');
    expect(sp.reportedQuantity).toBeGreaterThan(0);
    expect(sp.priceHistory.some((h) => h.source === 'aliexpress-api')).toBe(true);
    const cost = await t.prisma.costRecord.findFirstOrThrow({ where: { variantId: sp.variantId, effectiveTo: null } });
    expect(cost.source).toBe('supplier:aliexpress-api');
  });

  it('connects CJ with the API key and prefers stock data per warehouse', async () => {
    expect((await owner.get(`/api/integrations/suppliers/${acc.cjSupplier}/connect`)).body.connected).toBe(true);
    const r = await owner.post(`/api/integrations/supplier-products/${acc.cjSupplierProduct}/sync`);
    expect(r.body).toMatchObject({ ok: true, shipsFromCountry: expect.stringMatching(/^(CN|GB)$/) });
  });

  it('places a staff-confirmed supplier order and forwards supplier tracking to the marketplace', async () => {
    const order = await t.prisma.order.findFirstOrThrow({ where: { status: 'AWAITING_DISPATCH', lines: { some: { sku: 'FR-10002-M' } }, account: { marketplace: { in: ['EBAY_UK', 'AMAZON_UK'] } } } });
    const placed = await (await t.as('order_manager')).post(`/api/orders/${order.id}/supplier-order`);
    expect(placed.body.results[0]).toMatchObject({ ok: true, externalOrderId: expect.stringMatching(/^AE/) });
    // A second click never orders twice.
    expect((await (await t.as('order_manager')).post(`/api/orders/${order.id}/supplier-order`)).body.results[0].duplicate).toBe(true);
    const { SupplierSyncService } = await import('../src/suppliers/supplier-sync.service');
    const r = await t.app.get(SupplierSyncService).pollTracking();
    expect(r.shipped).toBeGreaterThanOrEqual(1);
    expect((await t.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('DISPATCHED');
  });
});
