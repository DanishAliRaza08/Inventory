import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isValidGtin } from '@fr/core';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { BulkUpdate, CreateProduct, ListProducts, SkuAliasBulk, UpdateProduct, UpdateVariant } from './products.schemas';

export const productCode = (n: number) => `FRP-${String(n).padStart(6, '0')}`;

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Filters, sorts and pages products in one SQL statement and returns only the page's ids and the
   * total. Each search branch is an indexed lookup (trigram / b-tree), so this stays fast on large
   * catalogues where an OR of EXISTS sub-queries (or a long `IN` list) would not.
   */
  private async pageIds(q: z.infer<typeof ListProducts>) {
    const conds: Prisma.Sql[] = [q.status ? Prisma.sql`p.status = ${q.status}::"ProductStatus"` : Prisma.sql`p.status <> 'ARCHIVED'`];
    if (q.search) {
      const like = `%${q.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const asNumber = /^(FRP-)?0*(\d+)$/i.exec(q.search)?.[2];
      conds.push(Prisma.sql`p.id IN (
        SELECT id FROM products WHERE title ILIKE ${like}
        UNION SELECT product_id FROM product_variants WHERE sku ILIKE ${like}
        UNION SELECT product_id FROM product_variants WHERE barcode = ${q.search}
        UNION SELECT v.product_id FROM sku_aliases a JOIN product_variants v ON v.id = a.variant_id WHERE lower(a.alias) = lower(${q.search})
        UNION SELECT v.product_id FROM supplier_products sp JOIN product_variants v ON v.id = sp.variant_id WHERE sp.supplier_sku = ${q.search} OR sp.supplier_product_id = ${q.search}
        UNION SELECT id FROM products WHERE product_number = ${asNumber ? Number(asNumber) : -1})`);
    }
    if (q.category) conds.push(Prisma.sql`p.category = ${q.category}`);
    if (q.brand) conds.push(Prisma.sql`p.brand = ${q.brand}`);
    if (q.fulfilmentModel) conds.push(Prisma.sql`p.fulfilment_model = ${q.fulfilmentModel}::"FulfilmentModel"`);
    if (q.supplierId) conds.push(Prisma.sql`EXISTS (SELECT 1 FROM product_variants v JOIN supplier_products sp ON sp.variant_id = v.id WHERE v.product_id = p.id AND sp.supplier_id = ${q.supplierId}::uuid)`);
    if (q.marketplace) conds.push(Prisma.sql`EXISTS (SELECT 1 FROM marketplace_listings l WHERE l.product_id = p.id AND l.marketplace = ${q.marketplace}::"Marketplace" AND l.status <> 'ARCHIVED')`);
    if (q.unlisted) conds.push(Prisma.sql`NOT EXISTS (SELECT 1 FROM marketplace_listings l WHERE l.product_id = p.id AND l.marketplace = ${q.unlisted}::"Marketplace" AND l.status <> 'ARCHIVED')`);
    // In stock — physical: available units on any variant; dropship: any variant with a supplier not out
    // of stock. Built as set operations (hash joins) rather than per-product EXISTS checks.
    const inStock = Prisma.sql`(
      SELECT v.product_id FROM inventory_records i JOIN product_variants v ON v.id = i.variant_id JOIN products pp ON pp.id = v.product_id
      WHERE i.available <> 0 AND pp.fulfilment_model = 'PHYSICAL'
      UNION
      SELECT v.product_id FROM supplier_products sp JOIN product_variants v ON v.id = sp.variant_id JOIN products pp ON pp.id = v.product_id
      WHERE sp.stock_status NOT IN ('OUT_OF_STOCK', 'DISCONTINUED') AND pp.fulfilment_model = 'DROPSHIP')`;
    if (q.stock === 'out') conds.push(Prisma.sql`p.id NOT IN ${inStock}`);
    if (q.stock === 'in') conds.push(Prisma.sql`p.id IN ${inStock}`);
    if (q.stock === 'low') conds.push(Prisma.sql`EXISTS (SELECT 1 FROM product_variants v JOIN supplier_products sp ON sp.variant_id = v.id WHERE v.product_id = p.id AND sp.stock_status = 'LOW_STOCK')`);
    const where = Prisma.join(conds, ' AND ');
    const order = q.sort === 'title' ? Prisma.sql`p.title ASC, p.id` : q.sort === 'oldest' ? Prisma.sql`p.created_at ASC, p.id ASC` : q.sort === 'number' ? Prisma.sql`p.product_number ASC` : Prisma.sql`p.created_at DESC, p.id DESC`;
    // One pass computes both the page and the total (the filter can be expensive, e.g. stock status).
    const rows = await this.prisma.$queryRaw<Array<{ id: string; total: number }>>`
      SELECT p.id, COUNT(*) OVER ()::int AS total FROM products p WHERE ${where} ORDER BY ${order} LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`;
    if (rows.length) return { ids: rows.map((r) => r.id), total: rows[0]!.total };
    const count = await this.prisma.$queryRaw<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM products p WHERE ${where}`;
    return { ids: [], total: count[0]?.n ?? 0 };
  }

  async list(q: z.infer<typeof ListProducts>) {
    const { ids, total } = await this.pageIds(q);
    const items = await this.prisma.product.findMany({
      where: { id: { in: ids } },
      include: {
        images: { where: { isMain: true }, take: 1 },
        variants: {
          select: {
            id: true, sku: true, size: true, colour: true, status: true,
            inventory: { select: { available: true, reserved: true, committed: true, safetyStock: true } },
            supplierProducts: { where: { priority: 1 }, select: { stockStatus: true, currentPrice: true, currency: true, supplier: { select: { name: true } } }, take: 1 },
            costRecords: { where: { effectiveTo: null }, take: 1 },
          },
        },
        listings: { where: { status: { not: 'ARCHIVED' } }, select: { marketplace: true, status: true } },
      },
    });
    const pos = new Map(ids.map((id, i) => [id, i]));
    items.sort((a, b) => pos.get(a.id)! - pos.get(b.id)!);
    return { items: items.map((p) => ({ ...p, code: productCode(p.productNumber) })), total, page: q.page, pageSize: q.pageSize };
  }

  async get(id: string) {
    const p = await this.prisma.product.findUnique({
      where: { id },
      include: {
        images: { orderBy: { position: 'asc' } },
        variants: {
          orderBy: { sku: 'asc' },
          include: {
            aliases: true,
            inventory: true,
            supplierProducts: { orderBy: { priority: 'asc' }, include: { supplier: { select: { id: true, name: true, type: true } } } },
            costRecords: { orderBy: { effectiveFrom: 'desc' }, take: 10 },
          },
        },
        listings: { include: { account: { select: { name: true, marketplace: true } } }, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Product not found.' });
    return { ...p, code: productCode(p.productNumber) };
  }

  async create(input: z.infer<typeof CreateProduct>, actor: AuthContext) {
    this.assertUniqueSkusInPayload(input.variants.map((v) => v.sku));
    for (const v of input.variants) if (v.barcode && !isValidGtin(v.barcode)) throw new BadRequestException({ code: 'GTIN_INVALID', message: `Invalid barcode for ${v.sku}` });
    const product = await this.prisma.$transaction(async (tx) => {
      const p = await tx.product.create({
        data: {
          title: input.title, description: input.description, category: input.category, brand: input.brand,
          countryOfOrigin: input.countryOfOrigin, status: input.status, fulfilmentModel: input.fulfilmentModel,
          attributes: input.attributes, restricted: input.restricted, createdById: actor.userId, updatedById: actor.userId,
        },
      });
      for (const v of input.variants) {
        const { initialCost, initialStock, ...variant } = v;
        const created = await tx.productVariant.create({ data: { ...variant, attributes: variant.attributes ?? {}, productId: p.id } });
        if (initialCost) {
          await tx.costRecord.create({ data: { variantId: created.id, effectiveFrom: new Date(), source: 'manual', createdById: actor.userId, ...initialCost } });
        }
        await this.createInventory(tx, created.id, input.fulfilmentModel === 'PHYSICAL' ? initialStock ?? 0 : 0, actor);
      }
      await this.audit.record(actor, { action: 'product.create', entityType: 'product', entityId: p.id, after: input }, tx);
      return p;
    });
    return this.get(product.id);
  }

  async update(id: string, input: z.infer<typeof UpdateProduct>, actor: AuthContext) {
    const before = await this.prisma.product.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();
    const after = await this.prisma.product.update({ where: { id }, data: { ...input, updatedById: actor.userId } });
    await this.audit.record(actor, { action: 'product.update', entityType: 'product', entityId: id, before, after });
    return after;
  }

  async addVariant(productId: string, input: z.infer<typeof CreateProduct>['variants'][number], actor: AuthContext) {
    const p = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!p) throw new NotFoundException();
    if (input.barcode && !isValidGtin(input.barcode)) throw new BadRequestException({ code: 'GTIN_INVALID', message: 'Invalid barcode' });
    return this.prisma.$transaction(async (tx) => {
      const { initialCost, initialStock, ...variant } = input;
      const v = await tx.productVariant.create({ data: { ...variant, attributes: variant.attributes ?? {}, productId } });
      if (initialCost) await tx.costRecord.create({ data: { variantId: v.id, effectiveFrom: new Date(), createdById: actor.userId, ...initialCost } });
      await this.createInventory(tx, v.id, p.fulfilmentModel === 'PHYSICAL' ? initialStock ?? 0 : 0, actor);
      await this.audit.record(actor, { action: 'variant.create', entityType: 'variant', entityId: v.id, after: input }, tx);
      return v;
    });
  }

  async updateVariant(id: string, input: z.infer<typeof UpdateVariant>, actor: AuthContext) {
    const before = await this.prisma.productVariant.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();
    if (input.barcode && !isValidGtin(input.barcode)) throw new BadRequestException({ code: 'GTIN_INVALID', message: 'Invalid barcode' });
    const after = await this.prisma.productVariant.update({ where: { id }, data: input });
    await this.audit.record(actor, { action: 'variant.update', entityType: 'variant', entityId: id, before, after });
    return after;
  }

  async bulkUpdate(input: z.infer<typeof BulkUpdate>, actor: AuthContext) {
    const r = await this.prisma.$transaction(async (tx) => {
      const res = await tx.product.updateMany({ where: { id: { in: input.productIds } }, data: { ...input.patch, updatedById: actor.userId } });
      await this.audit.record(actor, { action: 'product.bulk_update', entityType: 'product', after: { ids: input.productIds, patch: input.patch, count: res.count } }, tx);
      return res;
    });
    return { updated: r.count };
  }

  async archive(id: string, actor: AuthContext) {
    const live = await this.prisma.marketplaceListing.count({ where: { productId: id, status: { in: ['ACTIVE', 'PAUSED', 'PUBLISHING'] } } });
    if (live > 0) throw new BadRequestException({ code: 'HAS_LIVE_LISTINGS', message: `End the ${live} live listing(s) before archiving this product.` });
    return this.update(id, { status: 'ARCHIVED' }, actor);
  }

  async addSkuAliases(input: z.infer<typeof SkuAliasBulk>, actor: AuthContext) {
    const r = await this.prisma.skuAlias.createMany({ data: input.items, skipDuplicates: true });
    await this.audit.record(actor, { action: 'sku_alias.bulk_create', entityType: 'variant', after: { requested: input.items.length, created: r.count } });
    return { created: r.count, skipped: input.items.length - r.count };
  }

  /** Potential duplicates: shared barcodes, shared supplier product URLs, or near-identical titles. */
  async duplicates(limit = 100) {
    const [barcodes, urls, titles] = await Promise.all([
      this.prisma.$queryRaw<Array<{ key: string; skus: string[] }>>`
        SELECT barcode AS key, array_agg(sku ORDER BY sku) AS skus FROM product_variants
        WHERE barcode IS NOT NULL AND barcode <> '' GROUP BY barcode HAVING count(*) > 1 LIMIT ${limit}`,
      this.prisma.$queryRaw<Array<{ key: string; skus: string[] }>>`
        SELECT sp.url AS key, array_agg(v.sku ORDER BY v.sku) AS skus FROM supplier_products sp JOIN product_variants v ON v.id = sp.variant_id
        WHERE sp.url IS NOT NULL GROUP BY sp.url HAVING count(DISTINCT v.product_id) > 1 LIMIT ${limit}`,
      this.prisma.$queryRaw<Array<{ a: string; b: string; a_title: string; b_title: string; score: number }>>`
        SELECT p1.id AS a, p2.id AS b, p1.title AS a_title, p2.title AS b_title, similarity(p1.title, p2.title) AS score
        FROM products p1 JOIN products p2 ON p1.id < p2.id AND p1.title % p2.title
        WHERE p1.status <> 'ARCHIVED' AND p2.status <> 'ARCHIVED' AND similarity(p1.title, p2.title) > 0.85
        ORDER BY score DESC LIMIT ${limit}`,
    ]);
    return { sameBarcode: barcodes, sameSupplierUrl: urls, similarTitles: titles };
  }

  /** Global search across products, SKUs, aliases, listings, orders and suppliers. */
  async globalSearch(q: string, perms: Set<string>) {
    const s = q.trim();
    if (s.length < 2) return { products: [], variants: [], listings: [], orders: [], suppliers: [] };
    const [products, variants, listings, orders, suppliers] = await Promise.all([
      perms.has('products.read')
        ? this.prisma.product.findMany({ where: { title: { contains: s, mode: 'insensitive' } }, take: 8, select: { id: true, title: true, productNumber: true, status: true } })
        : [],
      perms.has('products.read')
        ? Promise.all([
            this.prisma.productVariant.findMany({ where: { OR: [{ sku: { contains: s, mode: 'insensitive' } }, { barcode: s }] }, take: 8, select: { id: true, sku: true, productId: true, product: { select: { title: true } } } }),
            this.prisma.productVariant.findMany({ where: { aliases: { some: { alias: { equals: s, mode: 'insensitive' } } } }, take: 8, select: { id: true, sku: true, productId: true, product: { select: { title: true } } } }),
          ]).then(([a, b]) => [...new Map([...a, ...b].map((v) => [v.id, v])).values()].slice(0, 8))
        : [],
      perms.has('listings.read')
        ? this.prisma.$queryRaw<Array<{ id: string; sku: string; marketplace: string; externalListingId: string | null; status: string }>>`
            SELECT id, sku, marketplace::text, external_listing_id AS "externalListingId", status::text FROM marketplace_listings
            WHERE external_listing_id = ${s} OR lower(sku) = lower(${s}) LIMIT 8`
        : [],
      perms.has('orders.read')
        ? this.prisma.order.findMany({
            where: { OR: [{ externalOrderId: s }, ...(/^\d+$/.test(s) ? [{ orderNumber: Number(s) }] : [])] },
            take: 8,
            select: { id: true, orderNumber: true, externalOrderId: true, marketplace: true, status: true },
          })
        : [],
      perms.has('suppliers.read')
        ? this.prisma.supplier.findMany({ where: { name: { contains: s, mode: 'insensitive' } }, take: 5, select: { id: true, name: true, type: true } })
        : [],
    ]);
    return { products: products.map((p) => ({ ...p, code: productCode(p.productNumber) })), variants, listings, orders, suppliers };
  }

  /** Opening stock is recorded as a RECEIVE movement so every unit is traceable. */
  private async createInventory(tx: Prisma.TransactionClient, variantId: string, openingStock: number, actor: AuthContext) {
    const rec = await tx.inventoryRecord.create({ data: { variantId, available: openingStock, policy: 'MANUAL' } });
    if (openingStock > 0) {
      await tx.inventoryMovement.create({
        data: { inventoryRecordId: rec.id, type: 'RECEIVE', fromBucket: 'EXTERNAL', toBucket: 'AVAILABLE', quantity: openingStock, reason: 'Opening stock', createdById: actor.userId },
      });
    }
  }

  private assertUniqueSkusInPayload(skus: string[]) {
    const seen = new Set<string>();
    for (const s of skus) {
      const k = s.toLowerCase();
      if (seen.has(k)) throw new BadRequestException({ code: 'DUPLICATE_SKU', message: `SKU ${s} appears more than once.` });
      seen.add(k);
    }
  }
}
