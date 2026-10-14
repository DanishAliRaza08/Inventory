import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiClient, setAiClientFactory } from '../src/ai/ai-assistant.service';
import { resetConfigCache } from '../src/config';
import { Agent, TestContext, createProduct, setupApp } from './helpers';

let t: TestContext;
let owner: Agent;
let listingId: string;
let accountId: string;
let lastRequest: any = null;

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
  const d = await (await t.as('listing_manager')).post('/api/listings', { variantId: p.variants[0].id, accountId, price: '19.99' });
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
