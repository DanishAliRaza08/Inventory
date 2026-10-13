import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent, TestContext, createProduct, setupApp } from './helpers';

let t: TestContext;
let demoUk: string;
let realUk: string;
let lister: Agent;
let approver: Agent;
let owner: Agent;

// 1x1 PNG scaled header trick isn't enough for size checks; build a real 800x800 PNG.
function png(width: number, height: number): Buffer {
  const { deflateSync } = require('zlib') as typeof import('zlib');
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.alloc((width + 1) * height, Math.floor(Math.random() * 255));
  for (let y = 0; y < height; y++) raw[y * (width + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const completeContent = {
  categoryId: '63861',
  condition: 'NEW',
  shippingPolicyId: 'ship-std',
  returnPolicyId: 'ret-30',
  dispatchTimeDays: 2,
  requiredAttributes: ['Size', 'Colour'],
  verifiedAttributes: ['Size', 'Colour', 'Material'],
};

async function readyProduct(over: Record<string, unknown> = {}) {
  const p = await createProduct(owner, over);
  const up = await owner.upload(`/api/products/${p.id}/images`, 'file', png(800, 800), 'main.png');
  expect(up.status).toBe(201);
  return p;
}

beforeAll(async () => {
  t = await setupApp();
  owner = await t.as('owner');
  lister = await t.as('listing_manager');
  approver = await t.as('listing_approver');
  const accounts = (await owner.get('/api/integrations/accounts')).body as Array<{ id: string; marketplace: string; environment: string }>;
  demoUk = accounts.find((a) => a.marketplace === 'EBAY_UK' && a.environment === 'DEMO')!.id;
  realUk = accounts.find((a) => a.marketplace === 'EBAY_UK' && a.environment === 'PRODUCTION')!.id;
});
afterAll(() => t.close());

describe('listing builder and approval workflow', () => {
  it('creates an incomplete draft from the master product, adapted to the marketplace', async () => {
    const p = await readyProduct({ brand: 'Rockstar', title: 'An Extremely Long Product Title For A Lovely Floral Summer Midi Dress With Pockets And Belt' });
    const r = await lister.post('/api/listings', { variantId: p.variants[0].id, accountId: demoUk });
    expect(r.status).toBe(201);
    expect(r.body.notes.join(' ')).toMatch(/shortened/);
    const l = await lister.get(`/api/listings/${r.body.listingId}`);
    expect(l.body.status).toBe('INCOMPLETE');
    expect(l.body.currency).toBe('GBP');
    const content = l.body.versions[0].content;
    expect(content.title.length).toBeLessThanOrEqual(80);
    expect(content.attributes).toMatchObject({ Size: '12', Colour: 'Blue', Brand: 'Rockstar' });
  });

  it('runs the full draft → validate → approve → publish → active lifecycle (demo connector)', async () => {
    const p = await readyProduct();
    const { body } = await lister.post('/api/listings', { variantId: p.variants[0].id, accountId: demoUk, price: '24.99' });
    const id = body.listingId;
    const saved = await lister.patch(`/api/listings/${id}`, { content: completeContent });
    expect(saved.body.validation.complete).toBe(true);
    expect((await lister.get(`/api/listings/${id}`)).body.status).toBe('DRAFT');

    expect((await lister.post(`/api/listings/${id}/submit`)).body.status).toBe('AWAITING_APPROVAL');
    // Lister cannot approve; approver can.
    expect((await lister.post(`/api/listings/${id}/approve`)).status).toBe(403);
    expect((await approver.post(`/api/listings/${id}/approve`, { note: 'looks good' })).body.status).toBe('APPROVED');
    // Lister cannot publish.
    expect((await lister.post(`/api/listings/${id}/publish`)).status).toBe(403);
    const pub = await approver.post(`/api/listings/${id}/publish`);
    expect(pub.status).toBe(202);

    const after = await approver.get(`/api/listings/${id}`);
    expect(after.body.status).toBe('ACTIVE');
    expect(after.body.externalListingId).toMatch(/^DEMO-EBAY_UK-/);
    expect(after.body.publishedVersionId).toBe(after.body.currentVersionId);
    expect(after.body.statusHistory.map((h: { toStatus: string }) => h.toStatus)).toEqual(
      expect.arrayContaining(['DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'PUBLISHING', 'ACTIVE']),
    );
    expect(after.body.operations[0]).toMatchObject({ operation: 'CREATE', status: 'SUCCEEDED' });

    // Revising a live listing creates a new version without touching the published one.
    await lister.post(`/api/listings/${id}/revise`);
    const ed = await lister.patch(`/api/listings/${id}`, { content: { description: 'Updated description.' } });
    expect(ed.body.newVersion).toBe(true);
    const rev = await lister.get(`/api/listings/${id}`);
    expect(rev.body.currentVersionId).not.toBe(rev.body.publishedVersionId);
    expect(rev.body.externalListingId).toBe(after.body.externalListingId);
  });

  it('never marks a listing active without marketplace confirmation, and keeps failures visible and retryable', async () => {
    const p = await readyProduct({ title: 'Failing dress [demo-fail]' });
    const { body } = await lister.post('/api/listings', { variantId: p.variants[0].id, accountId: demoUk, price: '24.99', content: completeContent });
    await lister.post(`/api/listings/${body.listingId}/submit`);
    await approver.post(`/api/listings/${body.listingId}/approve`);
    await approver.post(`/api/listings/${body.listingId}/publish`);
    const l = await approver.get(`/api/listings/${body.listingId}`);
    expect(l.body.status).toBe('PUBLICATION_FAILED');
    expect(l.body.externalListingId).toBeNull();
    expect(l.body.lastError).toMatch(/demo marketplace rejected/);
    expect(l.body.operations[0]).toMatchObject({ status: 'FAILED_PERMANENT', errorCode: 'DEMO_VALIDATION' });
    expect((await t.as('owner')) && (await owner.get('/api/notifications')).body.some((n: { type: string }) => n.type === 'LISTING_PUBLICATION_FAILED')).toBe(true);
    // Fix and revise: back to draft with the content preserved.
    await lister.patch(`/api/listings/${body.listingId}`, { content: { title: 'Fixed floral midi dress size 12 blue' } });
    expect((await lister.get(`/api/listings/${body.listingId}`)).body.status).toBe('DRAFT');
  });

  it('refuses to publish through an unconnected real marketplace account (no fake success)', async () => {
    const p = await readyProduct();
    const { body } = await lister.post('/api/listings', { variantId: p.variants[0].id, accountId: realUk, price: '24.99', content: completeContent });
    await lister.post(`/api/listings/${body.listingId}/submit`);
    await approver.post(`/api/listings/${body.listingId}/approve`);
    const pub = await approver.post(`/api/listings/${body.listingId}/publish`);
    expect(pub.status).toBe(409);
    expect(pub.body.code).toBe('ACCOUNT_NOT_CONNECTED');
    expect((await approver.get(`/api/listings/${body.listingId}`)).body.status).toBe('APPROVED');
  });

  it('official connectors report not-implemented operations honestly', async () => {
    const caps = await owner.get('/api/integrations/capabilities');
    expect(caps.body.matrix.EBAY_UK.CREATE_LISTING).toMatchObject({ status: 'planned' });
    expect(caps.body.matrix.AMAZON_UK.CREATE_LISTING.api).toMatch(/Listings Items API/);
  });

  it('blocks self-approval and requires approver compliance sign-off for restricted products', async () => {
    const p = await readyProduct({ restricted: true });
    const { body } = await owner.post('/api/listings', { variantId: p.variants[0].id, accountId: demoUk, price: '24.99', content: completeContent });
    await owner.post(`/api/listings/${body.listingId}/submit`);
    const self = await owner.post(`/api/listings/${body.listingId}/approve`);
    expect(self.body.code).toBe('BLOCKING_WARNINGS'); // restricted warning is checked first
    expect((await lister.patch(`/api/listings/${body.listingId}`, { content: { complianceSignedOff: true } })).status).toBe(403);
    const so = await approver.post(`/api/listings/${body.listingId}/compliance-signoff`, { note: 'Checked supplier safety documents' });
    expect(so.body.blockingCount).toBe(0);
    expect((await owner.get(`/api/listings/${body.listingId}`)).body.status).toBe('AWAITING_APPROVAL');
    expect((await owner.post(`/api/listings/${body.listingId}/approve`)).body.code).toBe('SELF_APPROVAL');
    expect((await approver.post(`/api/listings/${body.listingId}/approve`)).body.status).toBe('APPROVED');
  });

  it('editing an approved draft withdraws the approval', async () => {
    const p = await readyProduct();
    const { body } = await lister.post('/api/listings', { variantId: p.variants[0].id, accountId: demoUk, price: '24.99', content: completeContent });
    await lister.post(`/api/listings/${body.listingId}/submit`);
    await approver.post(`/api/listings/${body.listingId}/approve`);
    await lister.patch(`/api/listings/${body.listingId}`, { price: '19.99' });
    expect((await lister.get(`/api/listings/${body.listingId}`)).body.status).toBe('DRAFT');
  });

  it('rejects with a reason and notifies the creator', async () => {
    const p = await readyProduct();
    const { body } = await lister.post('/api/listings', { variantId: p.variants[0].id, accountId: demoUk, price: '24.99', content: completeContent });
    await lister.post(`/api/listings/${body.listingId}/submit`);
    expect((await approver.post(`/api/listings/${body.listingId}/reject`, {})).status).toBe(400);
    expect((await approver.post(`/api/listings/${body.listingId}/reject`, { note: 'Wrong category' })).body.status).toBe('DRAFT');
    const notes = await lister.get('/api/notifications');
    expect(notes.body.some((n: { type: string; body: string }) => n.type === 'DRAFT_REJECTED' && n.body === 'Wrong category')).toBe(true);
  });

  it('bulk publish shows a confirmation summary and refuses stale confirmations', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const p = await readyProduct();
      const { body } = await lister.post('/api/listings', { variantId: p.variants[0].id, accountId: demoUk, price: `2${i}.99`, content: completeContent });
      await lister.post(`/api/listings/${body.listingId}/submit`);
      ids.push(body.listingId);
    }
    const bulk = await approver.post('/api/listings/bulk-approve', { listingIds: ids });
    expect(bulk.body.approved).toBe(3);
    const preview = await approver.post('/api/listings/bulk-publish/preview', { listingIds: ids });
    expect(preview.body.eligibleCount).toBe(3);
    expect(preview.body.byAccount[0]).toMatchObject({ count: 3, currency: 'GBP', totalListedValue: '65.97' });
    // Price changes after preview -> token stale.
    await lister.patch(`/api/listings/${ids[0]}`, { price: '30.00' });
    const stale = await approver.post('/api/listings/bulk-publish', { listingIds: ids, confirmToken: preview.body.confirmToken });
    expect(stale.body.code).toBe('PREVIEW_STALE');
    const preview2 = await approver.post('/api/listings/bulk-publish/preview', { listingIds: ids });
    expect(preview2.body.eligibleCount).toBe(2);
    const ok = await approver.post('/api/listings/bulk-publish', { listingIds: ids, confirmToken: preview2.body.confirmToken });
    expect(ok.body.results.filter((r: { ok: boolean }) => r.ok)).toHaveLength(2);
  });

  it('emergency control stops publishing without deleting anything', async () => {
    const p = await readyProduct();
    const { body } = await lister.post('/api/listings', { variantId: p.variants[0].id, accountId: demoUk, price: '24.99', content: completeContent });
    await lister.post(`/api/listings/${body.listingId}/submit`);
    await approver.post(`/api/listings/${body.listingId}/approve`);
    await owner.put('/api/settings/controls.publishing_enabled', { value: false });
    const r = await approver.post(`/api/listings/${body.listingId}/publish`);
    expect(r.body.code).toBe('PUBLISHING_DISABLED');
    expect((await approver.get(`/api/listings/${body.listingId}`)).body.status).toBe('APPROVED');
    await owner.put('/api/settings/controls.publishing_enabled', { value: true });
    expect((await approver.post(`/api/listings/${body.listingId}/publish`)).status).toBe(202);
  });

  it('flags prices below the minimum profitable price', async () => {
    const p = await readyProduct();
    await owner.post('/api/fee-rules', { name: 'fee', marketplace: 'EBAY_UK', feeType: 'final_value', basis: 'order_total_incl_tax', currency: 'GBP', percent: '12', effectiveFrom: '2020-01-01' });
    const { body } = await lister.post('/api/listings', { variantId: p.variants[0].id, accountId: demoUk, price: '9.99', content: completeContent });
    const codes = body.validation.issues.map((i: { code: string }) => i.code);
    expect(codes).toContain('BELOW_MIN_PROFITABLE_PRICE');
    const sub = await lister.post(`/api/listings/${body.listingId}/submit`);
    expect(sub.status).toBe(200); // reviewer sees it...
    expect((await approver.post(`/api/listings/${body.listingId}/approve`)).body.code).toBe('BLOCKING_WARNINGS'); // ...but cannot approve
  });

  it('database refuses an ACTIVE listing without a marketplace id', async () => {
    const l = await t.prisma.marketplaceListing.findFirstOrThrow({ where: { status: 'DRAFT', externalListingId: null } });
    await expect(t.prisma.marketplaceListing.update({ where: { id: l.id }, data: { status: 'ACTIVE' } })).rejects.toThrow();
  });

  it('bulk-creates drafts priced by target margin', async () => {
    const a = await readyProduct();
    const b = await readyProduct();
    const r = await lister.post('/api/listings/bulk-drafts', { variantIds: [a.variants[0].id, b.variants[0].id], accountId: demoUk, pricing: { kind: 'margin', percent: '25' } });
    expect(r.body.created).toBe(2);
    expect(r.body.results[0].price).toMatch(/\.99$/);
  });
});
