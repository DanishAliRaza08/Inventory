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

  async list(q: z.infer<typeof ListProducts>) {
    const and: Prisma.ProductWhereInput[] = [];
    if (q.search) {
      const s = q.search;
      const asNumber = /^(FRP-)?0*(\d+)$/i.exec(s)?.[2];
      and.push({
        OR: [
          { title: { contains: s, mode: 'insensitive' } },
          { variants: { some: { sku: { contains: s, mode: 'insensitive' } } } },
          { variants: { some: { barcode: s } } },
          { variants: { some: { aliases: { some: { alias: { equals: s, mode: 'insensitive' } } } } } },
          { variants: { some: { supplierProducts: { some: { OR: [{ supplierSku: s }, { supplierProductId: s }] } } } } },
          ...(asNumber ? [{ productNumber: Number(asNumber) }] : []),
        ],
      });
    }
    if (q.status) and.push({ status: q.status });
    else and.push({ status: { not: 'ARCHIVED' } });
    if (q.category) and.push({ category: q.category });
    if (q.brand) and.push({ brand: q.brand });
    if (q.fulfilmentModel) and.push({ fulfilmentModel: q.fulfilmentModel });
    if (q.supplierId) and.push({ variants: { some: { supplierProducts: { some: { supplierId: q.supplierId } } } } });
    if (q.marketplace) and.push({ listings: { some: { marketplace: q.marketplace, status: { not: 'ARCHIVED' } } } });
    if (q.unlisted) and.push({ listings: { none: { marketplace: q.unlisted, status: { not: 'ARCHIVED' } } } });
    if (q.stock === 'out') {
      and.push({
        OR: [
          { fulfilmentModel: 'PHYSICAL', variants: { every: { inventory: { every: { available: 0 } } } } },
          { fulfilmentModel: 'DROPSHIP', variants: { every: { supplierProducts: { every: { stockStatus: { in: ['OUT_OF_STOCK', 'DISCONTINUED'] } } } } } },
        ],
      });
    } else if (q.stock === 'low') {
      and.push({ variants: { some: { supplierProducts: { some: { stockStatus: 'LOW_STOCK' } } } } });
    }
    const where: Prisma.ProductWhereInput = { AND: and };
    const orderBy: Prisma.ProductOrderByWithRelationInput =
      q.sort === 'title' ? { title: 'asc' } : q.sort === 'oldest' ? { createdAt: 'asc' } : q.sort === 'number' ? { productNumber: 'asc' } : { createdAt: 'desc' };

    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
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
      }),
      this.prisma.product.count({ where }),
    ]);
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
        await tx.inventoryRecord.create({
          data: { variantId: created.id, available: input.fulfilmentModel === 'PHYSICAL' ? initialStock ?? 0 : 0, policy: 'MANUAL' },
        });
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
      await tx.inventoryRecord.create({ data: { variantId: v.id, available: p.fulfilmentModel === 'PHYSICAL' ? initialStock ?? 0 : 0 } });
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
        ? this.prisma.productVariant.findMany({
            where: { OR: [{ sku: { contains: s, mode: 'insensitive' } }, { barcode: s }, { aliases: { some: { alias: { equals: s, mode: 'insensitive' } } } }] },
            take: 8,
            select: { id: true, sku: true, productId: true, product: { select: { title: true } } },
          })
        : [],
      perms.has('listings.read')
        ? this.prisma.marketplaceListing.findMany({
            where: { OR: [{ externalListingId: s }, { sku: { equals: s, mode: 'insensitive' } }] },
            take: 8,
            select: { id: true, sku: true, marketplace: true, externalListingId: true, status: true },
          })
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

  private assertUniqueSkusInPayload(skus: string[]) {
    const seen = new Set<string>();
    for (const s of skus) {
      const k = s.toLowerCase();
      if (seen.has(k)) throw new BadRequestException({ code: 'DUPLICATE_SKU', message: `SKU ${s} appears more than once.` });
      seen.add(k);
    }
  }
}
