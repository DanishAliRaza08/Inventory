import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IMPORT_FIELDS, IMPORT_TEMPLATE_HEADERS, ImportField, ImportRow, findDuplicateRows, mapAndValidateRow, suggestMapping } from '@fr/core';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/decorators';
import { CostsService } from '../costs/costs.service';
import { InventoryService } from '../inventory/inventory.service';
import { ListingsService } from '../listings/listings.service';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { QUEUES, QueueService } from '../queue/queue.service';
import { parseTable, writeTable } from './tabular';

const CHUNK = 200;
const IMPORT_CONCURRENCY = 6;

interface ImportCache {
  /** parent SKU (lower-case) -> product id, for grouping variations within a run. */
  parents: Map<string, string>;
  suppliers: Map<string, { id: string; defaultCurrency: string }>;
}

function supplierTypeFor(name: string) {
  const n = name.toLowerCase();
  if (n.includes('aliexpress')) return 'ALIEXPRESS' as const;
  if (n.includes('cj')) return 'CJ_DROPSHIPPING' as const;
  return 'MANUAL' as const;
}

@Injectable()
export class ImportsService implements OnModuleInit {
  private readonly logger = new Logger(ImportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
    private readonly costs: CostsService,
    private readonly inventory: InventoryService,
    private readonly listings: ListingsService,
  ) {}

  onModuleInit() {
    this.queue.register<{ jobId: string; actor: AuthContext & { permissions: string[] } }>(QUEUES.IMPORT, ({ jobId, actor }) =>
      this.execute(jobId, { ...actor, permissions: new Set(actor.permissions) }),
    );
  }

  // 1. Upload ------------------------------------------------------------------
  async upload(fileName: string, buf: Buffer, actor: AuthContext) {
    let table;
    try {
      table = await parseTable(fileName, buf);
    } catch (e) {
      throw new BadRequestException({ code: 'PARSE_ERROR', message: (e as Error).message });
    }
    if (!table.rows.length) throw new BadRequestException({ code: 'EMPTY_FILE', message: 'The file has no data rows.' });
    const job = await this.prisma.importJob.create({ data: { fileName, headers: table.headers, totalRows: table.rows.length, createdById: actor.userId } });
    for (let i = 0; i < table.rows.length; i += 1000) {
      await this.prisma.importRow.createMany({
        data: table.rows.slice(i, i + 1000).map((raw, j) => ({ jobId: job.id, rowNumber: i + j + 2, raw: raw as Prisma.InputJsonValue })),
      });
    }
    await this.audit.record(actor, { action: 'import.upload', entityType: 'import', entityId: job.id, after: { fileName, rows: table.rows.length } });
    return { id: job.id, headers: table.headers, totalRows: table.rows.length, suggestedMapping: suggestMapping(table.headers), sample: table.rows.slice(0, 5), fields: IMPORT_FIELDS };
  }

  // 2-7. Map, match, detect duplicates, validate, preview -------------------
  async validate(jobId: string, mapping: Partial<Record<ImportField, string>>, actor: AuthContext) {
    const job = await this.prisma.importJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException();
    if (!['UPLOADED', 'VALIDATED'].includes(job.status)) throw new ConflictException({ code: 'IMPORT_STATE', message: `Import is ${job.status}.` });
    const unknownHeaders = Object.values(mapping).filter((h) => h && !job.headers.includes(h));
    if (unknownHeaders.length) throw new BadRequestException({ code: 'UNKNOWN_COLUMN', message: `Columns not in file: ${unknownHeaders.join(', ')}` });
    const missingRequired = (Object.keys(IMPORT_FIELDS) as ImportField[]).filter((f) => IMPORT_FIELDS[f].required && !mapping[f]);
    if (missingRequired.length) throw new BadRequestException({ code: 'MAPPING_INCOMPLETE', message: `Map required fields: ${missingRequired.join(', ')}` });

    const rows = await this.prisma.importRow.findMany({ where: { jobId }, orderBy: { rowNumber: 'asc' } });
    const results = rows.map((r) => mapAndValidateRow(r.raw as Record<string, unknown>, mapping, r.rowNumber));
    const dups = findDuplicateRows(results);
    const skus = [...new Set(results.filter((r) => r.ok).map((r) => r.data!.sku.toLowerCase()))];
    const existing = await this.prisma.$queryRaw<Array<{ sku: string; title: string | null; product_title: string }>>`
      SELECT v.sku, v.title, p.title AS product_title FROM product_variants v JOIN products p ON p.id = v.product_id
      WHERE lower(v.sku) = ANY(${skus}::text[])`;
    const existingMap = new Map(existing.map((e) => [e.sku.toLowerCase(), e]));

    let valid = 0;
    let errorsCount = 0;
    const preview: Array<{ rowNumber: number; sku: string; action: string; changes?: Record<string, [unknown, unknown]> }> = [];
    const updates: Array<{ id: string; status: string; action: string | null; data: Prisma.InputJsonValue | typeof Prisma.JsonNull; errors: Prisma.InputJsonValue | typeof Prisma.JsonNull }> = [];
    rows.forEach((row, i) => {
      const r = results[i]!;
      if (!r.ok) {
        errorsCount++;
        updates.push({ id: row.id, status: 'INVALID', action: null, data: Prisma.JsonNull, errors: r.errors });
        return;
      }
      if (dups.has(r.rowNumber)) {
        errorsCount++;
        updates.push({ id: row.id, status: 'DUPLICATE', action: null, data: r.data as Prisma.InputJsonValue, errors: [{ field: 'sku', message: dups.get(r.rowNumber)! }] });
        return;
      }
      valid++;
      const ex = existingMap.get(r.data!.sku.toLowerCase());
      const action = ex ? 'UPDATE' : 'CREATE';
      updates.push({ id: row.id, status: 'VALID', action, data: r.data as Prisma.InputJsonValue, errors: Prisma.JsonNull });
      if (preview.length < 100) {
        preview.push({ rowNumber: r.rowNumber, sku: r.data!.sku, action, changes: ex && r.data!.title !== ex.product_title ? { title: [ex.product_title, r.data!.title] } : undefined });
      }
    });
    for (let i = 0; i < updates.length; i += 500) {
      await this.prisma.$transaction(updates.slice(i, i + 500).map((u) => this.prisma.importRow.update({ where: { id: u.id }, data: { status: u.status, action: u.action, data: u.data, errors: u.errors } })));
    }
    await this.prisma.importJob.update({ where: { id: jobId }, data: { status: 'VALIDATED', mapping: mapping as Prisma.InputJsonValue, validRows: valid, errorRows: errorsCount } });
    await this.audit.record(actor, { action: 'import.validate', entityType: 'import', entityId: jobId, after: { valid, errors: errorsCount } });
    const creates = updates.filter((u) => u.action === 'CREATE').length;
    return {
      totalRows: rows.length,
      validRows: valid,
      errorRows: errorsCount,
      creates,
      updates: valid - creates,
      errors: rows.flatMap((row, i) => (updates[i]!.status === 'VALID' ? [] : [{ rowNumber: row.rowNumber, errors: updates[i]!.errors }])).slice(0, 200),
      preview,
    };
  }

  // 8-9. Confirm & execute ----------------------------------------------------
  async commit(jobId: string, actor: AuthContext) {
    const job = await this.prisma.importJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException();
    if (!['VALIDATED', 'COMPLETED_WITH_ERRORS'].includes(job.status)) throw new ConflictException({ code: 'IMPORT_STATE', message: 'Validate the import before running it.' });
    if (job.validRows === 0) throw new ConflictException({ code: 'NOTHING_TO_IMPORT', message: 'No valid rows to import.' });
    await this.prisma.importJob.update({ where: { id: jobId }, data: { status: 'IMPORTING', startedAt: new Date() } });
    await this.audit.record(actor, { action: 'import.commit', entityType: 'import', entityId: jobId });
    await this.queue.enqueue(QUEUES.IMPORT, { jobId, actor: { ...actor, permissions: [...actor.permissions] } }, { jobId: `import:${jobId}:${Date.now()}` });
    return { id: jobId, status: 'IMPORTING' };
  }

  /** Processes VALID (and previously FAILED) rows in chunks; IMPORTED rows are never re-applied. */
  async execute(jobId: string, actor: AuthContext) {
    const accounts = await this.prisma.marketplaceAccount.findMany({ orderBy: { createdAt: 'asc' } });
    const cache: ImportCache = { parents: new Map(), suppliers: new Map() };
    for (;;) {
      const batch = await this.prisma.importRow.findMany({ where: { jobId, status: { in: ['VALID', 'FAILED'] }, importedAt: null }, orderBy: { rowNumber: 'asc' }, take: CHUNK });
      // Rows that FAILED in this run are marked with importedAt=epoch sentinel below to avoid infinite loops.
      if (!batch.length) break;
      const progress = { processed: 0, created: 0, updated: 0, failed: 0 };
      // Suppliers are created up-front so concurrent rows never race on the unique name.
      for (const name of new Set(batch.map((r) => (r.data as unknown as ImportRow).supplier).filter((n): n is string => !!n))) {
        if (!cache.suppliers.has(name)) {
          const currency = batch.map((r) => r.data as unknown as ImportRow).find((d) => d.supplier === name)?.currency ?? 'USD';
          cache.suppliers.set(name, await this.prisma.supplier.upsert({ where: { name }, update: {}, create: { name, type: supplierTypeFor(name), defaultCurrency: currency } }));
        }
      }
      // Rows of the same parent product run in order; different products run concurrently.
      const groups = new Map<string, typeof batch>();
      for (const row of batch) {
        const d = row.data as unknown as ImportRow;
        const key = (d.parent_sku ?? d.product_id ?? d.sku).toLowerCase();
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
      const runGroup = async (rows: typeof batch) => {
        for (const row of rows) {
          const data = row.data as unknown as ImportRow;
          progress.processed++;
          try {
            const warnings = await this.importRow(jobId, row.rowNumber, data, actor, accounts, cache);
            await this.prisma.importRow.update({ where: { id: row.id }, data: { status: 'IMPORTED', importedAt: new Date(), errors: warnings.length ? warnings.map((w) => ({ field: 'warning', message: w })) : Prisma.JsonNull } });
            if (row.action === 'CREATE') progress.created++;
            else progress.updated++;
          } catch (e) {
            progress.failed++;
            await this.prisma.importRow.update({ where: { id: row.id }, data: { status: 'FAILED', importedAt: new Date(0), errors: [{ field: 'row', message: (e as Error).message }] } });
          }
        }
      };
      const queue = [...groups.values()];
      await Promise.all(Array.from({ length: Math.min(IMPORT_CONCURRENCY, queue.length) }, async () => {
        for (let g = queue.shift(); g; g = queue.shift()) await runGroup(g);
      }));
      // Progress is published once per chunk.
      await this.prisma.importJob.update({
        where: { id: jobId },
        data: { processedRows: { increment: progress.processed }, createdCount: { increment: progress.created }, updatedCount: { increment: progress.updated }, failedCount: { increment: progress.failed } },
      });
    }
    // Reset the sentinel so failed rows can be retried by committing again after fixes.
    await this.prisma.importRow.updateMany({ where: { jobId, status: 'FAILED' }, data: { importedAt: null } });
    const failed = await this.prisma.importRow.count({ where: { jobId, status: 'FAILED' } });
    const job = await this.prisma.importJob.update({ where: { id: jobId }, data: { status: failed ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED', finishedAt: new Date() } });
    await this.audit.record(actor, { action: 'import.complete', entityType: 'import', entityId: jobId, after: { created: job.createdCount, updated: job.updatedCount, failed } });
  }

  /** Case-insensitive SKU lookup that uses the lower(sku) unique index. */
  private async variantIdBySku(tx: Tx, sku: string): Promise<string | null> {
    const r = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM product_variants WHERE lower(sku) = lower(${sku}) LIMIT 1`;
    return r[0]?.id ?? null;
  }

  private async resolveProductId(tx: Tx, d: ImportRow, cache: ImportCache): Promise<string | null> {
    if (d.product_id) {
      const n = /^(FRP-)?0*(\d+)$/i.exec(d.product_id)?.[2];
      const p = await tx.product.findFirst({ where: n ? { productNumber: Number(n) } : { id: d.product_id } });
      if (!p) throw new Error(`Product ${d.product_id} not found`);
      return p.id;
    }
    if (d.parent_sku) {
      const key = d.parent_sku.toLowerCase();
      const cached = cache.parents.get(key);
      if (cached) return cached;
      const parentId = await this.variantIdBySku(tx, d.parent_sku);
      if (parentId) {
        const parent = await tx.productVariant.findUniqueOrThrow({ where: { id: parentId }, select: { productId: true } });
        return parent.productId;
      }
      const grouped = await tx.product.findFirst({ where: { attributes: { path: ['_parentSku'], equals: d.parent_sku } } });
      if (grouped) return grouped.id;
    }
    return null;
  }

  private async importRow(
    jobId: string,
    rowNumber: number,
    d: ImportRow,
    actor: AuthContext,
    accounts: Array<{ id: string; marketplace: string }>,
    cache: ImportCache,
  ): Promise<string[]> {
    const warnings: string[] = [];
    const variantId = await this.prisma.$transaction(async (tx) => {
      const existingId = await this.variantIdBySku(tx, d.sku);
      let variant = existingId ? await tx.productVariant.findUnique({ where: { id: existingId }, include: { product: true } }) : null;
      if (!variant) {
        let productId = await this.resolveProductId(tx, d, cache);
        if (!productId) {
          const p = await tx.product.create({
            data: {
              title: d.title,
              description: d.description ?? '',
              category: d.category,
              brand: d.brand,
              fulfilmentModel: d.fulfilment_model ?? 'DROPSHIP',
              attributes: d.parent_sku ? { _parentSku: d.parent_sku } : {},
              createdById: actor.userId,
              updatedById: actor.userId,
            },
          });
          productId = p.id;
        }
        if (d.parent_sku) cache.parents.set(d.parent_sku.toLowerCase(), productId);
        const v = await tx.productVariant.create({
          data: { productId, sku: d.sku, title: d.parent_sku ? d.title : null, size: d.size, colour: d.colour, material: d.material, barcode: d.barcode, weightGrams: d.weight_g },
        });
        await tx.inventoryRecord.create({ data: { variantId: v.id } });
        variant = await tx.productVariant.findUniqueOrThrow({ where: { id: v.id }, include: { product: true } });
      } else {
        await tx.productVariant.update({
          where: { id: variant.id },
          data: { size: d.size ?? undefined, colour: d.colour ?? undefined, material: d.material ?? undefined, barcode: d.barcode ?? undefined, weightGrams: d.weight_g ?? undefined },
        });
        if (!d.parent_sku) {
          await tx.product.update({
            where: { id: variant.productId },
            data: { title: d.title, description: d.description ?? undefined, category: d.category ?? undefined, brand: d.brand ?? undefined, fulfilmentModel: d.fulfilment_model ?? undefined, updatedById: actor.userId },
          });
        }
      }

      // Supplier & cost
      if (d.supplier) {
        let supplier = cache.suppliers.get(d.supplier);
        if (!supplier) {
          supplier = await tx.supplier.upsert({ where: { name: d.supplier }, update: {}, create: { name: d.supplier, type: supplierTypeFor(d.supplier), defaultCurrency: d.currency ?? 'USD' } });
          cache.suppliers.set(d.supplier, supplier);
        }
        const existingSp = await tx.supplierProduct.findUnique({ where: { supplierId_variantId: { supplierId: supplier.id, variantId: variant.id } } });
        const price = d.cost !== undefined ? String(d.cost) : existingSp?.currentPrice.toString() ?? '0';
        const shipping = d.supplier_shipping !== undefined ? String(d.supplier_shipping) : existingSp?.shippingCost.toString() ?? '0';
        const currency = d.currency ?? existingSp?.currency ?? supplier.defaultCurrency;
        const sp = await tx.supplierProduct.upsert({
          where: { supplierId_variantId: { supplierId: supplier.id, variantId: variant.id } },
          update: { currentPrice: price, shippingCost: shipping, currency, url: d.supplier_url ?? undefined, supplierSku: d.supplier_sku ?? undefined, supplierProductId: d.supplier_product_id ?? undefined, shipsFromCountry: d.ships_from ?? undefined },
          create: { supplierId: supplier.id, variantId: variant.id, currentPrice: price, shippingCost: shipping, currency, url: d.supplier_url, supplierSku: d.supplier_sku, supplierProductId: d.supplier_product_id, shipsFromCountry: d.ships_from },
        });
        if (!existingSp || !existingSp.currentPrice.equals(sp.currentPrice) || !existingSp.shippingCost.equals(sp.shippingCost) || existingSp.currency !== sp.currency) {
          await tx.supplierPriceHistory.create({ data: { supplierProductId: sp.id, price: sp.currentPrice, shippingCost: sp.shippingCost, currency: sp.currency, source: `import:${jobId}`, recordedById: actor.userId } });
        }
        if (d.supplier_sku) {
          await tx.skuAlias.upsert({ where: { type_scope_alias: { type: 'SUPPLIER', scope: supplier.id, alias: d.supplier_sku } }, update: {}, create: { variantId: variant.id, type: 'SUPPLIER', scope: supplier.id, alias: d.supplier_sku } });
        }
      }
      if (d.cost !== undefined) {
        const open = await tx.costRecord.findFirst({ where: { variantId: variant.id, effectiveTo: null } });
        const same =
          open &&
          open.currency === d.currency &&
          open.supplierPrice.equals(d.cost) &&
          open.supplierShipping.equals(d.supplier_shipping ?? open.supplierShipping) &&
          open.packaging.equals(d.packaging ?? open.packaging);
        if (!same) {
          await this.costs.addCost(
            variant.id,
            {
              currency: d.currency!,
              supplierPrice: String(d.cost),
              supplierShipping: String(d.supplier_shipping ?? open?.supplierShipping ?? 0),
              packaging: String(d.packaging ?? open?.packaging ?? 0),
              importDuty: open?.importDuty.toString() ?? '0',
              nonRecoverableTax: open?.nonRecoverableTax.toString() ?? '0',
              fxConversionPercent: open?.fxConversionPercent.toString() ?? '0',
              purchasePaymentPercent: open?.purchasePaymentPercent.toString() ?? '0',
              otherPerUnit: open?.otherPerUnit.toString() ?? '0',
              source: `import:${jobId}`,
              verified: false,
            },
            actor,
            tx,
          );
        }
      }

      // Stock: owned stock for PHYSICAL, supplier availability (never owned) for DROPSHIP.
      if (d.stock !== undefined || d.safety_stock !== undefined) {
        const rec = await this.inventory.ensureRecord(variant.id, 'MAIN', tx);
        if (d.safety_stock !== undefined) await tx.inventoryRecord.update({ where: { id: rec.id }, data: { safetyStock: d.safety_stock } });
        if (d.stock !== undefined) {
          if (variant.product.fulfilmentModel === 'PHYSICAL') {
            const diff = d.stock - rec.available;
            if (diff !== 0) {
              await this.inventory.move(variant.id, { type: diff > 0 ? 'ADJUST_UP' : 'ADJUST_DOWN', quantity: Math.abs(diff), reason: `Import ${jobId} row ${rowNumber}`, location: 'MAIN', idempotencyKey: `import:${jobId}:${rowNumber}` }, actor, tx);
            }
          } else {
            const updated = await tx.supplierProduct.updateMany({
              where: { variantId: variant.id, priority: 1 },
              data: { reportedQuantity: d.stock, stockStatus: d.stock > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK', stockCheckedAt: new Date(), stockSource: `import:${jobId}` },
            });
            if (!updated.count) warnings.push('Stock ignored: dropship product has no primary supplier to attach availability to.');
          }
        }
      }
      if (d.marketplace && d.marketplace_sku) {
        await tx.skuAlias.upsert({
          where: { type_scope_alias: { type: 'MARKETPLACE', scope: d.marketplace, alias: d.marketplace_sku } },
          update: {},
          create: { variantId: variant.id, type: 'MARKETPLACE', scope: d.marketplace, alias: d.marketplace_sku },
        });
      }
      return variant.id;
    });

    // Marketplace price -> draft listing (never changes a live/approved listing's price).
    if (d.marketplace && d.selling_price !== undefined) {
      const account = accounts.find((a) => a.marketplace === d.marketplace);
      if (!account) {
        warnings.push(`No ${d.marketplace} account configured; selling price not applied.`);
      } else {
        const sku = d.marketplace_sku ?? d.sku;
        const listing = await this.prisma.marketplaceListing.findUnique({ where: { accountId_sku: { accountId: account.id, sku } } });
        if (!listing) {
          await this.listings.createDraft({ variantId, accountId: account.id, sku, price: String(d.selling_price) }, actor);
        } else if (['INCOMPLETE', 'DRAFT', 'VALIDATION_FAILED'].includes(listing.status)) {
          await this.listings.updateDraft(listing.id, { price: String(d.selling_price) }, actor);
        } else if (!listing.price || !listing.price.equals(d.selling_price)) {
          warnings.push(`Listing ${sku} is ${listing.status}; price change to ${d.selling_price} must go through the repricing approval workflow.`);
        }
      }
    }
    return warnings;
  }

  // 10. History, progress, error reports ----------------------------------------
  list() {
    return this.prisma.importJob.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
  }

  async get(jobId: string) {
    const job = await this.prisma.importJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException();
    const counts = await this.prisma.importRow.groupBy({ by: ['status'], where: { jobId }, _count: true });
    return { ...job, rowStatus: Object.fromEntries(counts.map((c) => [c.status, c._count])) };
  }

  /** Rows that need fixing, in the original column layout plus an error column, ready to correct and re-upload. */
  async errorReport(jobId: string, format: 'csv' | 'xlsx') {
    const job = await this.prisma.importJob.findUniqueOrThrow({ where: { id: jobId } });
    const rows = await this.prisma.importRow.findMany({ where: { jobId, status: { in: ['INVALID', 'DUPLICATE', 'FAILED'] } }, orderBy: { rowNumber: 'asc' } });
    const headers = [...job.headers, '__row', '__errors'];
    return writeTable(
      format,
      headers,
      rows.map((r) => ({
        ...(r.raw as Record<string, unknown>),
        __row: r.rowNumber,
        __errors: ((r.errors as Array<{ field: string; message: string }>) ?? []).map((e) => `${e.field}: ${e.message}`).join('; '),
      })),
      'Errors',
    );
  }

  template(format: 'csv' | 'xlsx') {
    const example: Record<string, unknown> = {
      product_id: '', parent_sku: 'FR-10001', sku: 'FR-10001-BLU-12', title: "Women's Floral Midi Dress", description: 'Lightweight floral midi dress.',
      category: 'Dresses', brand: '', barcode: '', size: '12', colour: 'Blue', material: 'Polyester', weight_g: 250, supplier: 'CJ Dropshipping',
      supplier_url: 'https://example.com/supplier/product/123', supplier_sku: 'CJ-123-BLU-12', supplier_product_id: '123', ships_from: 'CN', cost: '6.50', supplier_shipping: '2.10',
      packaging: '0.20', currency: 'USD', fulfilment_model: 'DROPSHIP', stock: 120, safety_stock: '', selling_price: '24.99', marketplace: 'EBAY_UK', marketplace_sku: '',
    };
    return writeTable(format, IMPORT_TEMPLATE_HEADERS, [example], 'Products');
  }
}
