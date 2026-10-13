import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent, TestContext, setupApp } from './helpers';

let t: TestContext;
let owner: Agent;

function csv(rows: string[][]) {
  return Buffer.from(rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n'));
}

const HEADERS = ['Item SKU', 'Product Title', 'Parent', 'Size', 'Colour', 'Supplier', 'Supplier URL', 'Unit Cost', 'Shipping', 'Currency', 'Fulfilment', 'Qty', 'Price', 'Channel'];

beforeAll(async () => {
  t = await setupApp({ demo: false });
  owner = await t.as('owner');
});
afterAll(() => t.close());

async function runImport(buf: Buffer, name = 'products.csv') {
  const up = await owner.upload('/api/imports', 'file', buf, name);
  expect(up.status).toBe(201);
  const v = await owner.post(`/api/imports/${up.body.id}/validate`, { mapping: up.body.suggestedMapping });
  expect(v.status).toBe(201);
  const c = await owner.post(`/api/imports/${up.body.id}/commit`);
  expect(c.status).toBe(201);
  const job = await owner.get(`/api/imports/${up.body.id}`);
  return { id: up.body.id as string, upload: up.body, validation: v.body, job: job.body };
}

describe('bulk import (acceptance: 5,000+ UK and 300+ US products)', () => {
  it('imports 5,000 UK and 300 US SKUs with costs, suppliers, stock and prices', async () => {
    const rows: string[][] = [HEADERS];
    for (let i = 0; i < 5000; i++) {
      const parent = `UKP-${Math.floor(i / 4)}`;
      rows.push([`UK-${i}`, `UK Dress ${Math.floor(i / 4)}`, parent, ['8', '10', '12', '14'][i % 4]!, 'Blue', 'CJ Dropshipping', `https://example.com/p/${Math.floor(i / 4)}`, '6.50', '2.10', 'USD', 'DROPSHIP', '50', i < 100 ? '24.99' : '', i < 100 ? 'EBAY_UK' : '']);
    }
    for (let i = 0; i < 300; i++) {
      rows.push([`US-${i}`, `US Hoodie ${i}`, '', 'M', 'Black', 'Local Warehouse', '', '12.00', '0', 'USD', 'PHYSICAL', '20', i < 50 ? '39.99' : '', i < 50 ? 'EBAY_US' : '']);
    }
    const started = Date.now();
    const r = await runImport(csv(rows));
    const seconds = (Date.now() - started) / 1000;
    expect(r.upload.suggestedMapping).toMatchObject({ sku: 'Item SKU', title: 'Product Title', parent_sku: 'Parent', cost: 'Unit Cost', supplier_shipping: 'Shipping', stock: 'Qty', selling_price: 'Price', marketplace: 'Channel' });
    expect(r.validation).toMatchObject({ totalRows: 5300, validRows: 5300, errorRows: 0, creates: 5300 });
    expect(r.job.status).toBe('COMPLETED');
    expect(r.job.createdCount).toBe(5300);

    expect(await t.prisma.productVariant.count()).toBe(5300);
    expect(await t.prisma.product.count()).toBe(1250 + 300); // UK variants grouped 4 per parent
    expect(await t.prisma.costRecord.count({ where: { effectiveTo: null } })).toBe(5300);
    expect(await t.prisma.marketplaceListing.count({ where: { marketplace: 'EBAY_UK' } })).toBe(100);
    expect(await t.prisma.marketplaceListing.count({ where: { marketplace: 'EBAY_US', currency: 'USD' } })).toBe(50);
    // Dropship stock goes to supplier availability, physical stock to owned inventory.
    expect(await t.prisma.supplierProduct.count({ where: { reportedQuantity: 50 } })).toBe(5000);
    expect(await t.prisma.inventoryRecord.count({ where: { available: 20 } })).toBe(300);
    expect(await t.prisma.inventoryRecord.count({ where: { available: { gt: 0 }, variant: { sku: { startsWith: 'UK-' } } } })).toBe(0);
    // eslint-disable-next-line no-console
    console.log(`Imported 5,300 rows in ${seconds.toFixed(1)}s`);
  }, 600_000);

  it('re-import updates costs without rewriting history and does not duplicate products', async () => {
    const rows = [HEADERS, ['UK-0', 'UK Dress 0', 'UKP-0', '8', 'Blue', 'CJ Dropshipping', 'https://example.com/p/0', '7.25', '2.10', 'USD', 'DROPSHIP', '40', '', '']];
    const r = await runImport(csv(rows));
    expect(r.validation.updates).toBe(1);
    expect(r.job.updatedCount).toBe(1);
    const v = await t.prisma.productVariant.findFirstOrThrow({ where: { sku: 'UK-0' }, include: { costRecords: { orderBy: { effectiveFrom: 'asc' } } } });
    expect(v.costRecords.map((c) => c.supplierPrice.toString())).toEqual(['6.5', '7.25']);
    expect(v.costRecords[0]!.effectiveTo).not.toBeNull();
    expect(await t.prisma.productVariant.count()).toBe(5300);
  }, 120_000);

  it('reports invalid and duplicate rows and lets them be downloaded for correction', async () => {
    const rows = [
      HEADERS,
      ['GOOD-1', 'Good row', '', '', '', '', '', '5.00', '', 'GBP', 'PHYSICAL', '3', '', ''],
      ['bad sku!', 'Bad', '', '', '', '', 'not a url', '-1', '', '', '', '', '', ''],
      ['GOOD-1', 'Duplicate', '', '', '', '', '', '', '', '', '', '', '', ''],
      ['NOPRICE-MP', 'x', '', '', '', '', '', '', '', '', '', '', '10.00', ''],
    ];
    const up = await owner.upload('/api/imports', 'file', csv(rows), 'mixed.csv');
    const v = await owner.post(`/api/imports/${up.body.id}/validate`, { mapping: up.body.suggestedMapping });
    expect(v.body).toMatchObject({ validRows: 1, errorRows: 3 });
    const fields = v.body.errors.flatMap((e: { errors: Array<{ field: string }> }) => e.errors.map((x) => x.field));
    expect(fields).toEqual(expect.arrayContaining(['sku', 'supplier_url', 'cost', 'marketplace']));
    const report = await owner.get(`/api/imports/${up.body.id}/errors?format=csv`);
    expect(report.status).toBe(200);
    expect(report.text.split('\n')[0]).toContain('__errors');
    expect(report.text.split('\n').filter(Boolean)).toHaveLength(4);
    const c = await owner.post(`/api/imports/${up.body.id}/commit`);
    expect(c.status).toBe(201);
    expect((await owner.get(`/api/imports/${up.body.id}`)).body).toMatchObject({ status: 'COMPLETED', createdCount: 1 });
  });

  it('parses XLSX uploads and serves the template', async () => {
    const tpl = await owner.get('/api/imports/template?format=xlsx').buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(tpl.status).toBe(200);
    const up = await owner.upload('/api/imports', 'file', tpl.body as Buffer, 'template.xlsx');
    expect(up.status).toBe(201);
    expect(up.body.totalRows).toBe(1);
    expect(up.body.suggestedMapping.sku).toBe('sku');
  });

  it('exports products in the import template format', async () => {
    const res = await owner.get('/api/exports/products?format=csv');
    expect(res.status).toBe(200);
    const lines = res.text.trim().split('\n');
    expect(lines[0]).toMatch(/^product_id,parent_sku,sku,title/);
    expect(lines.length).toBeGreaterThan(5300);
  });
});
