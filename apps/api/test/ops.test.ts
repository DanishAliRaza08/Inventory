import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiAssistantService, AiClient, setAiClientFactory } from '../src/ai/ai-assistant.service';
import { resetConfigCache } from '../src/config';
import { deflateSync } from 'zlib';
import { Agent, TestContext, createProduct, setupApp } from './helpers';

/** Small valid grey PNG. */
function png(w = 800, h = 800): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h, 200); for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

let t: TestContext;
let owner: Agent;
let listingId: string;
let accountId: string;
let lastRequest: any = null;
let productId: string;
let variantId: string;

function stubClient(output: object, stop_reason = 'end_turn'): AiClient {
  return {
    messages: {
      create: async (body) => {
        lastRequest = body;
        return { id: 'msg_test', type: 'message', role: 'assistant', model: body.model, stop_reason, stop_sequence: null, content: [{ type: 'text', text: JSON.stringify(output), citations: null }], usage: { input_tokens: 100, output_tokens: 50 } } as any;
      },
    },
  };
}

beforeAll(async () => {
  t = await setupApp();
  owner = await t.as('owner');
  accountId = (await owner.get('/api/integrations/accounts')).body.find((a: any) => a.marketplace === 'EBAY_UK').id;
  const p = await createProduct(owner, { title: 'Satin Slip Skirt', brand: 'Rockstar', category: 'Skirts', variants: [{ sku: 'OPS-SKIRT-10', size: '10', colour: 'Champagne', material: 'Polyester satin', initialCost: { currency: 'GBP', supplierPrice: '6.00' } }] });
  productId = p.id;
  variantId = p.variants[0].id;
  const d = await (await t.as('listing_manager')).post('/api/listings', { variantId, accountId, price: '19.99' });
  expect(d.status).toBe(201);
  listingId = d.body.listingId;
}, 120_000);

afterAll(async () => {
  setAiClientFactory(null);
  await t?.close();
});

describe('AI assistant', () => {
  it('gives a facts-only demo suggestion in demo mode without an API key', async () => {
    const s = await owner.get('/api/ai/status');
    expect(s.body).toMatchObject({ configured: false, demoMode: true });
    const r = await (await t.as('listing_manager')).post(`/api/ai/listings/${listingId}/suggest`, {});
    expect(r.status).toBe(200);
    expect(r.body.source).toBe('demo');
    expect(r.body.suggestion.title).toContain('Satin Slip Skirt');
    expect(r.body.suggestion.claimsNeedingVerification.join(' ')).toContain('Polyester satin');
  });

  it('reports not configured without an API key outside demo mode', async () => {
    process.env.DEMO_MODE = 'false';
    resetConfigCache();
    try {
      const r = await (await t.as('listing_manager')).post(`/api/ai/listings/${listingId}/suggest`, {});
      expect(r.status).toBe(503);
      expect(r.body.code).toBe('AI_NOT_CONFIGURED');
    } finally {
      process.env.DEMO_MODE = 'true';
      resetConfigCache();
    }
  });

  it('sends only catalogue facts, enforces marketplace limits and never edits the listing', async () => {
    const longTitle = 'Rockstar Champagne Satin Slip Skirt Size 10 Polyester Satin Midi Length Elegant Party Evening Wear';
    setAiClientFactory(() => stubClient({ title: longTitle, description: 'A satin slip skirt.', bulletPoints: ['a', 'b'], searchKeywords: ['satin skirt'], categorySuggestion: { name: 'Clothing > Skirts', reason: 'category' }, missingInformation: [{ field: 'length', why: 'not recorded' }], claimsNeedingVerification: [], warnings: [] }));
    const before = await owner.get(`/api/listings/${listingId}`);
    const r = await (await t.as('listing_manager')).post(`/api/ai/listings/${listingId}/suggest`, { instructions: 'Keep it short' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.appliedAutomatically).toBe(false);
    expect(r.body.model).toBe('claude-opus-5-5');
    // eBay UK: 80-char title, no bullet points.
    expect(r.body.suggestion.title.length).toBeLessThanOrEqual(80);
    expect(r.body.suggestion.bulletPoints).toEqual([]);
    expect(r.body.suggestion.warnings.join(' ')).toMatch(/trimmed/);
    // Request shape: structured output + adaptive thinking; facts include material, never price or cost.
    expect(lastRequest.model).toBe('claude-opus-5-5');
    expect(lastRequest.thinking).toEqual({ type: 'adaptive' });
    expect(lastRequest.output_config.format.type).toBe('json_schema');
    const prompt = lastRequest.messages[0].content as string;
    expect(prompt).toContain('Polyester satin');
    expect(prompt).toContain('Keep it short');
    expect(prompt).not.toContain('19.99');
    expect(prompt).not.toContain('6.00');
    const after = await owner.get(`/api/listings/${listingId}`);
    expect(after.body.currentVersionId).toBe(before.body.currentVersionId);
    const audit = await t.prisma.auditLog.findFirst({ where: { action: 'ai.listing_suggest', entityId: listingId } });
    expect(audit).toBeTruthy();
  });

  it('surfaces refusals instead of returning empty content', async () => {
    setAiClientFactory(() => stubClient({}, 'refusal'));
    const r = await (await t.as('listing_manager')).post(`/api/ai/listings/${listingId}/suggest`, {});
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('AI_REFUSED');
  });

  it('requires listings.write', async () => {
    const r = await (await t.as('viewer')).post(`/api/ai/listings/${listingId}/suggest`, {});
    expect(r.status).toBe(403);
  });
});

describe('Image checks', () => {
  let imageId: string;
  it('records a labelled demo result without an API key, which does not affect validation', async () => {
    setAiClientFactory(null);
    const up = await owner.upload(`/api/products/${productId}/images`, 'file', png(), 'skirt.png');
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    imageId = up.body.id;
    const r = await (await t.as('listing_manager')).post(`/api/ai/images/${imageId}/check`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.checkResult.source).toBe('demo');
    expect(r.body.checkedAt).toBeTruthy();
  });

  it('sends the image to the model and turns detected text into a blocking listing check', async () => {
    setAiClientFactory(() => stubClient({ hasText: true, hasWatermark: false, hasBorderOrCollage: false, backgroundIsPlainWhite: false, showsProductClearly: true, notes: ['"SALE" text in the corner'] }));
    const r = await (await t.as('listing_manager')).post(`/api/ai/images/${imageId}/check`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.checkResult).toMatchObject({ source: 'claude', hasText: true });
    const blocks = lastRequest.messages[0].content;
    expect(blocks[0].type).toBe('image');
    expect(blocks[0].source.media_type).toBe('image/png');
    expect(lastRequest.output_config.format.type).toBe('json_schema');
    await t.prisma.marketplaceListing.update({ where: { id: listingId }, data: { status: 'DRAFT' } });
    const patch = await (await t.as('listing_manager')).patch(`/api/listings/${listingId}`, { content: { imageIds: [imageId] } });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    const v = await (await t.as('listing_manager')).post(`/api/listings/${listingId}/validate`);
    const issues = (v.body.issues ?? v.body.validation?.issues) as Array<{ code: string; blocking: boolean }>;
    expect(issues.find((i) => i.code === 'IMAGE_TEXT')?.blocking).toBe(true);
    expect(issues.map((i) => i.code)).not.toContain('MAIN_IMAGE_BACKGROUND'); // eBay listing: no white-background rule
  });

  it('checks pending images in the background only when configured', async () => {
    setAiClientFactory(null);
    const r = await t.app.get(AiAssistantService).checkPendingImages();
    expect(r).toEqual({ skipped: 'AI not configured' });
  });
});

describe('Listing templates', () => {
  it('creates, previews against a real SKU, updates and deletes a template', async () => {
    const lm = await t.as('listing_manager');
    const body = { name: 'Skirts UK', marketplace: 'EBAY_UK', titleTemplate: '{{#brand}}{{brand}} {{/brand}}{{title}} {{colour}} Size {{size}}', descriptionTemplate: '{{description}}{{#material}}\nMaterial: {{material}}{{/material}}', bulletTemplates: [], isDefault: true };
    const c = await lm.post('/api/listings/templates', body);
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const prev = await lm.post('/api/listings/templates/preview', { variantId, marketplace: 'EBAY_UK', titleTemplate: body.titleTemplate, descriptionTemplate: body.descriptionTemplate });
    expect(prev.status, JSON.stringify(prev.body)).toBe(200);
    expect(prev.body.title).toBe('Rockstar Satin Slip Skirt Champagne Size 10');
    expect(prev.body.description).toContain('Material: Polyester satin');
    const u = await lm.put(`/api/listings/templates/${c.body.id}`, { ...body, name: 'Skirts UK v2' });
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    expect(u.body.name).toBe('Skirts UK v2');
    const builtIn = await lm.get('/api/listings/templates/built-in');
    expect(builtIn.body.AMAZON_UK.bullets.length).toBeGreaterThan(0);
    expect((await (await t.as('viewer')).delete(`/api/listings/templates/${c.body.id}`)).status).toBe(403);
    expect((await lm.delete(`/api/listings/templates/${c.body.id}`)).status).toBe(200);
    expect((await lm.get('/api/listings/templates')).body.find((x: any) => x.id === c.body.id)).toBeUndefined();
  });
});

describe('Listing list search', () => {
  it('finds listings by product title, partial SKU and marketplace listing id, with status and paging', async () => {
    await t.prisma.marketplaceListing.update({ where: { id: listingId }, data: { externalListingId: null } });
    const ids = async (qs: string) => ((await owner.get(`/api/listings?${qs}`)).body.items as Array<{ id: string }>).map((x) => x.id);
    expect(await ids('search=satin%20slip')).toContain(listingId);
    expect(await ids('search=skirt-1')).toContain(listingId);
    expect(await ids('search=ops_skirt')).not.toContain(listingId); // _ is literal
    const l = await t.prisma.marketplaceListing.findUniqueOrThrow({ where: { id: listingId } });
    expect(await ids(`search=OPS-SKIRT-10&status=${l.status}`)).toEqual([listingId]);
    expect(await ids('search=OPS-SKIRT-10&status=ACTIVE')).toEqual([]);
    const r = await owner.get('/api/listings?pageSize=1&page=1');
    expect(r.body.items).toHaveLength(1);
    expect(r.body.total).toBeGreaterThanOrEqual(1);
    expect(r.body.statusCounts).toBeTypeOf('object');
  });
});

describe('Automation rules', () => {
  it('validates conditions and allowed actions per kind', async () => {
    const bad = await owner.post('/api/automation/rules', { name: 'x', kind: 'DISPATCH_DEADLINE', action: 'PAUSE_LISTINGS' });
    expect(bad.status).toBe(400);
  });

  it('runs a rule manually and notifies about matches', async () => {
    // Workflow transitions are covered in listings.test.ts; put the draft straight into the queue here.
    await t.prisma.marketplaceListing.update({ where: { id: listingId }, data: { status: 'AWAITING_APPROVAL' } });
    const rule = await owner.post('/api/automation/rules', { name: 'Drafts waiting', kind: 'DRAFTS_AWAITING_APPROVAL', action: 'NOTIFY', conditions: { olderThanHours: 0 }, enabled: true });
    expect(rule.status, JSON.stringify(rule.body)).toBe(201);
    const run = await owner.post(`/api/automation/rules/${rule.body.id}/run`);
    expect(run.status, JSON.stringify(run.body)).toBeLessThan(300);
    expect(JSON.stringify(run.body)).toContain('OPS-SKIRT-10');
    const rules = await owner.get('/api/automation/rules');
    expect(rules.body.find((r: any) => r.id === rule.body.id).lastRunAt).toBeTruthy();
  });

  it('is restricted to automation managers', async () => {
    const r = await (await t.as('viewer')).post('/api/automation/rules', { name: 'x', kind: 'DAILY_SALES_REPORT', action: 'NOTIFY' });
    expect(r.status).toBe(403);
  });
});

describe('Reports', () => {
  it('lists and runs every report with a data-status label', async () => {
    const list = await owner.get('/api/reports');
    expect(list.status).toBe(200);
    expect(list.body.length).toBeGreaterThanOrEqual(16);
    for (const rep of list.body) {
      const r = await owner.get(`/api/reports/${rep.key}?preset=custom&from=2026-01-01&to=2026-12-31`);
      expect(r.status, `${rep.key}: ${JSON.stringify(r.body)}`).toBe(200);
      expect(Array.isArray(r.body.rows)).toBe(true);
    }
  });

  it('exports CSV', async () => {
    const r = await owner.get('/api/reports/profit_by_sku/export?preset=custom&from=2026-01-01&to=2026-12-31');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/csv/);
    expect(r.text.split('\n')[0]).toContain('SKU');
  });

  it('rejects unknown reports', async () => {
    expect((await owner.get('/api/reports/nope')).status).toBe(404);
  });
});
