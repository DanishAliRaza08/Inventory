import { describe, expect, it } from 'vitest';
import { dropshipAvailableToSell, findDuplicateRows, mapAndValidateRow, physicalAvailableToSell, planInventorySync, suggestMapping } from '../src';

const now = new Date('2026-05-01T12:00:00Z');

describe('availability', () => {
  it('physical ATS subtracts safety stock but not other buckets', () => {
    expect(physicalAvailableToSell({ available: 10, reserved: 2, committed: 3, damaged: 1, returned: 0, safetyStock: 2 }).availableToSell).toBe(8);
    expect(physicalAvailableToSell({ available: 1, reserved: 0, committed: 0, damaged: 0, returned: 0, safetyStock: 2 }).availableToSell).toBe(0);
  });
  it('dropship applies buffer and cap, never treating supplier stock as owned', () => {
    const r = dropshipAvailableToSell({ status: 'IN_STOCK', reportedQuantity: 1000, checkedAt: '2026-05-01T10:00:00Z', source: 'cj' }, undefined, now);
    expect(r.availableToSell).toBe(10);
    expect(dropshipAvailableToSell({ status: 'LOW_STOCK', reportedQuantity: 6, checkedAt: '2026-05-01T10:00:00Z', source: 'cj' }, undefined, now).availableToSell).toBe(1);
  });
  it('treats stale or unknown supplier data as unavailable', () => {
    const stale = dropshipAvailableToSell({ status: 'IN_STOCK', reportedQuantity: 50, checkedAt: '2026-04-20T00:00:00Z', source: 'ali' }, undefined, now);
    expect(stale).toMatchObject({ availableToSell: 0, stale: true });
    expect(dropshipAvailableToSell({ status: 'IN_STOCK', reportedQuantity: 50, checkedAt: null, source: 'ali' }, undefined, now).stale).toBe(true);
    expect(dropshipAvailableToSell({ status: 'OUT_OF_STOCK', reportedQuantity: 50, checkedAt: now, source: 'ali' }, undefined, now).availableToSell).toBe(0);
  });
});

describe('sync planning', () => {
  const listings = [
    { listingId: 'a', status: 'ACTIVE' as const, currentQuantity: 5 },
    { listingId: 'b', status: 'PAUSED' as const, currentQuantity: 0, autoPaused: true },
    { listingId: 'c', status: 'PAUSED' as const, currentQuantity: 0, autoPaused: false },
  ];
  it('auto-pauses when nothing is available', () => {
    const plan = planInventorySync({ policy: 'AUTO_PAUSE', availableToSell: 0, mode: 'SHARED', listings, requireRelistApproval: false });
    expect(plan.find((p) => p.listingId === 'a')!.action).toBe('PAUSE');
  });
  it('resumes only auto-paused listings, and only without relist approval', () => {
    const plan = planInventorySync({ policy: 'AUTO_PAUSE', availableToSell: 4, mode: 'SHARED', listings, requireRelistApproval: false });
    expect(plan.map((p) => p.action)).toEqual(['UPDATE_QUANTITY', 'RESUME', 'NONE']);
    const gated = planInventorySync({ policy: 'AUTO_PAUSE', availableToSell: 4, mode: 'SHARED', listings, requireRelistApproval: true });
    expect(gated[1]!.action).toBe('NEEDS_RELIST_APPROVAL');
  });
  it('honours manual policy, monitor-only and the kill switch', () => {
    expect(planInventorySync({ policy: 'MANUAL', availableToSell: 0, mode: 'SHARED', listings, requireRelistApproval: false }).every((p) => p.action === 'NONE')).toBe(true);
    expect(planInventorySync({ policy: 'SUPPLIER_MONITOR', availableToSell: 2, mode: 'SHARED', listings, requireRelistApproval: false })[0]!.action).toBe('ALERT_ONLY');
    expect(planInventorySync({ policy: 'AUTO_SYNC', availableToSell: 2, mode: 'SHARED', listings, requireRelistApproval: false, syncDisabled: true }).every((p) => p.action === 'NONE')).toBe(true);
  });
  it('splits pools by percentage', () => {
    const plan = planInventorySync({ policy: 'AUTO_SYNC', availableToSell: 10, mode: 'PERCENTAGE', listings: [{ listingId: 'x', status: 'ACTIVE', currentQuantity: 0, allocation: 30 }], requireRelistApproval: false });
    expect(plan[0]!.targetQuantity).toBe(3);
  });
});

describe('import rows', () => {
  const headers = ['Item SKU', 'Product Title', 'Unit Cost', 'Currency', 'Price', 'Channel', 'EAN', 'Supplier URL'];
  const mapping = suggestMapping(headers);
  it('suggests mappings from common header names', () => {
    expect(mapping).toMatchObject({ sku: 'Item SKU', title: 'Product Title', cost: 'Unit Cost', currency: 'Currency', selling_price: 'Price', marketplace: 'Channel', barcode: 'EAN', supplier_url: 'Supplier URL' });
  });
  it('validates and normalises a row', () => {
    const r = mapAndValidateRow({ 'Item SKU': 'FR-10001', 'Product Title': 'Dress', 'Unit Cost': '£8.50', Currency: 'gbp', Price: '24.99', Channel: 'ebay_uk', EAN: '', 'Supplier URL': '' }, mapping, 2);
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ sku: 'FR-10001', cost: 8.5, currency: 'GBP', marketplace: 'EBAY_UK', selling_price: 24.99 });
  });
  it('reports errors per field', () => {
    const r = mapAndValidateRow({ 'Item SKU': 'bad sku!', 'Product Title': '', 'Unit Cost': '-1', Currency: '', EAN: '123' }, mapping, 3);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.field)).toEqual(expect.arrayContaining(['sku', 'title', 'cost', 'barcode']));
  });
  it('detects duplicate SKUs within a file', () => {
    const rows = [2, 3].map((n) => mapAndValidateRow({ 'Item SKU': 'A1', 'Product Title': 't' }, mapping, n));
    expect(findDuplicateRows(rows).get(3)).toMatch(/row 2/);
  });
});
