import { describe, expect, it } from 'vitest';
import { ListingDraftInput, allowedEvents, isValidGtin, transition, validateListing } from '../src';

const lister = { permissions: ['listings.write', 'listings.submit'] };
const approver = { permissions: ['listings.approve', 'listings.publish', 'listings.end'] };
const system = { permissions: [], system: true };

describe('listing lifecycle', () => {
  it('follows draft -> approval -> publishing -> active only on marketplace confirmation', () => {
    expect(transition('INCOMPLETE', 'SAVE', lister, { complete: true }).to).toBe('DRAFT');
    expect(transition('DRAFT', 'SUBMIT', lister, { complete: true }).to).toBe('AWAITING_APPROVAL');
    expect(transition('AWAITING_APPROVAL', 'APPROVE', approver).to).toBe('APPROVED');
    expect(transition('APPROVED', 'PUBLISH', approver).to).toBe('PUBLISHING');
    expect(() => transition('PUBLISHING', 'MARKETPLACE_CONFIRMED', approver)).toThrow(/marketplace integration/);
    expect(transition('PUBLISHING', 'MARKETPLACE_CONFIRMED', system).to).toBe('ACTIVE');
  });
  it('cannot jump straight from draft to active or publishing', () => {
    expect(() => transition('DRAFT', 'PUBLISH', approver)).toThrow(/Cannot PUBLISH/);
    expect(allowedEvents('DRAFT')).not.toContain('MARKETPLACE_CONFIRMED');
  });
  it('enforces permissions', () => {
    expect(() => transition('AWAITING_APPROVAL', 'APPROVE', lister)).toThrow(/listings.approve/);
    expect(() => transition('APPROVED', 'PUBLISH', lister)).toThrow(/listings.publish/);
  });
  it('blocks approval with compliance warnings, self-approval and when publishing is disabled', () => {
    expect(() => transition('AWAITING_APPROVAL', 'APPROVE', approver, { blockingWarnings: 1 })).toThrow(/unresolved/);
    expect(() => transition('AWAITING_APPROVAL', 'APPROVE', approver, { restrictedUnresolved: true })).toThrow(/compliance/);
    expect(() => transition('AWAITING_APPROVAL', 'APPROVE', approver, { approverIsSubmitter: true })).toThrow(/different user/);
    expect(transition('AWAITING_APPROVAL', 'APPROVE', approver, { approverIsSubmitter: true, allowSelfApproval: true }).to).toBe('APPROVED');
    expect(() => transition('APPROVED', 'PUBLISH', approver, { publishingDisabled: true })).toThrow(/emergency/);
  });
  it('failed publications stay visible and can be retried or revised', () => {
    expect(transition('PUBLISHING', 'MARKETPLACE_FAILED', system).to).toBe('PUBLICATION_FAILED');
    expect(transition('PUBLICATION_FAILED', 'RETRY', approver).to).toBe('PUBLISHING');
    expect(transition('PUBLICATION_FAILED', 'REVISE', lister).to).toBe('DRAFT');
  });
});

const good: ListingDraftInput = {
  marketplace: 'EBAY_UK', currency: 'GBP', title: "Women's Floral Summer Midi Dress Size 12 Blue", description: 'Lightweight midi dress.',
  categoryId: '63861', condition: 'NEW', price: '24.99', quantityPolicy: 'SYNC', shippingPolicyId: 's1', returnPolicyId: 'r1', dispatchTimeDays: 2,
  images: [{ url: 'https://x/1.jpg', width: 1600, height: 1600, format: 'jpeg', isMain: true, sha256: 'a' }],
  attributes: { Size: '12', Colour: 'Blue' }, requiredAttributes: ['Size', 'Colour'], verifiedAttributes: ['Size', 'Colour'],
};

describe('listing validation', () => {
  it('passes a complete eBay UK listing', () => {
    const r = validateListing(good);
    expect(r.issues.filter((i) => i.severity !== 'info')).toEqual([]);
    expect(r.valid && r.complete).toBe(true);
  });
  it('enforces the eBay 80 character title limit and promotional phrases', () => {
    const r = validateListing({ ...good, title: 'x'.repeat(81) });
    expect(r.issues.map((i) => i.code)).toContain('TITLE_TOO_LONG');
    expect(validateListing({ ...good, title: 'Floral Midi Dress FREE SHIPPING blue' }).issues.map((i) => i.code)).toContain('PROMOTIONAL_PHRASE');
  });
  it('requires category attributes, currency and marketplace-specific fields', () => {
    const r = validateListing({ ...good, attributes: { Size: '12' }, currency: 'USD' });
    expect(r.complete).toBe(false);
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['ATTRIBUTE_REQUIRED', 'CURRENCY_MISMATCH']));
    const amz = validateListing({ ...good, marketplace: 'AMAZON_UK' });
    expect(amz.issues.map((i) => i.field)).toEqual(expect.arrayContaining(['brand', 'gtin']));
  });
  it('flags unverified claims and restricted products as blocking', () => {
    const r = validateListing({ ...good, description: 'Waterproof and hypoallergenic', restrictedProduct: true });
    expect(r.issues.filter((i) => i.code === 'UNVERIFIED_CLAIM')).toHaveLength(2);
    expect(r.issues.find((i) => i.code === 'RESTRICTED_PRODUCT')!.blocking).toBe(true);
    expect(r.valid).toBe(true); // warnings, not errors: can be saved, cannot be approved
    expect(r.blockingCount).toBe(3);
  });
  it('checks images: size, format, duplicates', () => {
    const r = validateListing({ ...good, images: [good.images![0]!, { url: 'b', width: 300, height: 300, format: 'bmp', sha256: 'a' }] });
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['IMAGE_TOO_SMALL', 'IMAGE_DUPLICATE']));
  });
  it('warns when price is below minimum profitable price', () => {
    expect(validateListing({ ...good, minimumProfitablePrice: '30' }).issues.map((i) => i.code)).toContain('BELOW_MIN_PROFITABLE_PRICE');
  });
  it('validates GTIN check digits', () => {
    expect(isValidGtin('5012345678900')).toBe(true);
    expect(isValidGtin('5012345678901')).toBe(false);
    expect(isValidGtin('036000291452')).toBe(true);
  });
});
