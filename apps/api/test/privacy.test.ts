import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomerPiiService } from '../src/privacy/customer-pii.service';
import { TestContext, setupApp } from './helpers';

let t: TestContext;
let pii: CustomerPiiService;

async function makeOrder(marketplace: 'AMAZON_UK' | 'EBAY_UK', orderedAt = new Date()) {
  const account = await t.prisma.marketplaceAccount.findFirstOrThrow({ where: { marketplace, environment: 'PRODUCTION' } });
  return t.prisma.order.create({
    data: { accountId: account.id, marketplace, externalOrderId: `X-${Math.random()}`, status: 'PAID', orderedAt, currency: 'GBP' },
  });
}

const ADDRESS = { name: 'Jane Buyer', email: 'jane@example.com', phone: '07700900123', line1: '1 High Street', city: 'Leeds', postcode: 'LS1 1AA', country: 'GB' };

beforeAll(async () => {
  t = await setupApp({ demo: false });
  pii = t.app.get(CustomerPiiService);
});
afterAll(() => t.close());

describe('customer personal data (Amazon self-fulfilment)', () => {
  it('is encrypted at rest', async () => {
    const o = await makeOrder('AMAZON_UK');
    await pii.store(o.id, ADDRESS);
    const raw = await t.prisma.$queryRaw<Array<Record<string, string>>>`SELECT * FROM order_customers WHERE order_id = ${o.id}::uuid`;
    const dump = JSON.stringify(raw);
    for (const v of ['Jane Buyer', 'jane@example.com', '1 High Street', 'LS1 1AA', '07700900123']) expect(dump).not.toContain(v);
  });

  it('can only be read with the customer-data permission, and every read is audited', async () => {
    const o = await makeOrder('AMAZON_UK');
    await pii.store(o.id, ADDRESS);
    expect((await (await t.as('viewer')).get(`/api/orders/${o.id}/customer`)).status).toBe(403);
    expect((await (await t.as('finance_manager')).get(`/api/orders/${o.id}/customer`)).status).toBe(403);
    const r = await (await t.as('order_manager')).get(`/api/orders/${o.id}/customer`);
    expect(r.body).toMatchObject({ name: 'Jane Buyer', line1: '1 High Street', postcode: 'LS1 1AA', purged: false });
    const audit = await t.prisma.auditLog.count({ where: { action: 'customer_pii.read', entityId: o.id } });
    expect(audit).toBe(1);
  });

  it('Amazon data is scheduled for deletion 30 days after delivery; the limit cannot be raised', async () => {
    const o = await makeOrder('AMAZON_UK', new Date('2026-09-01T00:00:00Z'));
    await pii.store(o.id, ADDRESS);
    await pii.markDelivered(o.id, new Date('2026-09-05T00:00:00Z'));
    const row = await t.prisma.orderCustomer.findUniqueOrThrow({ where: { orderId: o.id } });
    expect(row.purgeAfter!.toISOString()).toBe('2026-10-05T00:00:00.000Z');
    const owner = await t.as('owner');
    expect((await owner.put('/api/settings/privacy.amazon_pii_retention_days_after_delivery', { value: 31 })).status).toBe(400);
    expect((await owner.put('/api/settings/privacy.amazon_pii_retention_days_after_delivery', { value: 14 })).status).toBe(200);
    await owner.put('/api/settings/privacy.amazon_pii_retention_days_after_delivery', { value: 30 });
  });

  it('other marketplaces use the general retention period', async () => {
    const o = await makeOrder('EBAY_UK', new Date('2026-09-01T00:00:00Z'));
    await pii.store(o.id, ADDRESS);
    const row = await t.prisma.orderCustomer.findUniqueOrThrow({ where: { orderId: o.id } });
    expect(row.purgeAfter!.toISOString()).toBe('2026-11-30T00:00:00.000Z'); // 90 days
  });

  it('purges expired data but keeps the order', async () => {
    const o = await makeOrder('AMAZON_UK', new Date('2026-01-01T00:00:00Z'));
    await pii.store(o.id, ADDRESS);
    const r = await (await t.as('owner')).post('/api/privacy/purge');
    expect(r.body.purged).toBeGreaterThanOrEqual(1);
    const row = await t.prisma.orderCustomer.findUniqueOrThrow({ where: { orderId: o.id } });
    expect([row.name, row.line1, row.postcode, row.email]).toEqual([null, null, null, null]);
    expect(row.purgedAt).not.toBeNull();
    expect(await t.prisma.order.count({ where: { id: o.id } })).toBe(1);
    const read = await (await t.as('order_manager')).get(`/api/orders/${o.id}/customer`);
    expect(read.body).toMatchObject({ purged: true, country: 'GB' });
  });
});
