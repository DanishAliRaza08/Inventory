import { INestApplicationContext, Logger } from '@nestjs/common';
import { MarketplaceCode } from '@fr/core';
import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AuthContext } from '../auth/decorators';
import { AutomationService, RuleInput } from '../automation/automation.service';
import { NormalizedOrder } from '../integrations/connector';
import { ListingContent } from '../listings/listing-content';
import { SyncService } from '../integrations/sync.service';
import { InventoryService } from '../inventory/inventory.service';
import { OrdersService } from '../orders/orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { seedDemo } from '../seed';

/**
 * Generates a realistic DEMO business: ~25 products, listings on the four DEMO accounts and
 * about 90 days of orders, fees, settlements, refunds, returns and expenses. Orders are pushed
 * through the real ingestion / dispatch / reconciliation code so profit is calculated the same
 * way as for live data. All data is fake and every account involved is a DEMO account.
 */

const log = new Logger('DemoData');

// Deterministic PRNG so every run produces the same business.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Model = 'DROPSHIP' | 'PHYSICAL';
interface DemoProduct {
  title: string;
  category: string;
  brand: string | null;
  material: string;
  colours: string[];
  sizes: string[];
  cost: number; // supplier price, in supplier currency
  ship: number;
  priceGbp: number;
  model: Model;
  supplier: 'cj' | 'ae' | 'uk';
}

const CATALOGUE: DemoProduct[] = [
  { title: "Women's Satin Slip Midi Skirt", category: 'Skirts', brand: 'Rockstar', material: 'Polyester satin', colours: ['Champagne', 'Black'], sizes: ['8', '10', '12', '14'], cost: 6.2, ship: 2.1, priceGbp: 22.99, model: 'DROPSHIP', supplier: 'cj' },
  { title: "Women's Ribbed Knit Bodycon Dress", category: 'Dresses', brand: 'Rockstar', material: 'Viscose blend', colours: ['Mocha', 'Black'], sizes: ['S', 'M', 'L'], cost: 7.4, ship: 2.3, priceGbp: 26.99, model: 'DROPSHIP', supplier: 'cj' },
  { title: "Men's Heavyweight Cotton T-Shirt", category: 'T-Shirts', brand: 'Rockstar Basics', material: '100% cotton', colours: ['White', 'Black', 'Sage'], sizes: ['M', 'L', 'XL'], cost: 3.1, ship: 1.2, priceGbp: 14.99, model: 'PHYSICAL', supplier: 'uk' },
  { title: "Women's High Waist Wide Leg Trousers", category: 'Trousers', brand: 'Rockstar', material: 'Polyester', colours: ['Black', 'Camel'], sizes: ['8', '10', '12', '14'], cost: 8.1, ship: 2.6, priceGbp: 29.99, model: 'DROPSHIP', supplier: 'ae' },
  { title: 'Unisex Oversized Fleece Hoodie', category: 'Hoodies', brand: 'Rockstar Basics', material: 'Cotton-polyester fleece', colours: ['Grey Marl', 'Navy'], sizes: ['S', 'M', 'L', 'XL'], cost: 9.2, ship: 3.4, priceGbp: 34.99, model: 'PHYSICAL', supplier: 'uk' },
  { title: "Women's Faux Leather Biker Jacket", category: 'Jackets', brand: 'Rockstar', material: 'PU faux leather', colours: ['Black'], sizes: ['S', 'M', 'L'], cost: 15.8, ship: 4.9, priceGbp: 54.99, model: 'DROPSHIP', supplier: 'cj' },
  { title: "Men's Slim Fit Stretch Chinos", category: 'Trousers', brand: 'Rockstar', material: 'Cotton with elastane', colours: ['Stone', 'Navy'], sizes: ['30', '32', '34', '36'], cost: 8.6, ship: 2.8, priceGbp: 27.99, model: 'DROPSHIP', supplier: 'ae' },
  { title: "Women's Puff Sleeve Square Neck Top", category: 'Tops', brand: 'Rockstar', material: 'Cotton blend', colours: ['White', 'Lilac'], sizes: ['S', 'M', 'L'], cost: 4.3, ship: 1.7, priceGbp: 17.99, model: 'DROPSHIP', supplier: 'ae' },
  { title: "Women's Cable Knit Jumper", category: 'Knitwear', brand: 'Rockstar', material: 'Acrylic', colours: ['Cream', 'Oat'], sizes: ['S', 'M', 'L'], cost: 9.9, ship: 3.2, priceGbp: 32.99, model: 'DROPSHIP', supplier: 'cj' },
  { title: "Men's Quilted Puffer Gilet", category: 'Jackets', brand: 'Rockstar', material: 'Nylon shell, polyester fill', colours: ['Black', 'Olive'], sizes: ['M', 'L', 'XL'], cost: 13.2, ship: 4.1, priceGbp: 44.99, model: 'DROPSHIP', supplier: 'cj' },
  { title: "Women's Floral Wrap Midi Dress", category: 'Dresses', brand: 'Rockstar', material: 'Chiffon', colours: ['Blue Floral', 'Pink Floral'], sizes: ['8', '10', '12', '14'], cost: 7.9, ship: 2.4, priceGbp: 29.99, model: 'DROPSHIP', supplier: 'ae' },
  { title: 'Unisex Jogger Sweatpants', category: 'Loungewear', brand: 'Rockstar Basics', material: 'Cotton-polyester fleece', colours: ['Black', 'Grey Marl'], sizes: ['S', 'M', 'L', 'XL'], cost: 6.4, ship: 2.2, priceGbp: 24.99, model: 'PHYSICAL', supplier: 'uk' },
  { title: "Women's Seamless Sports Bra", category: 'Activewear', brand: null, material: 'Nylon with elastane', colours: ['Black', 'Dusty Rose'], sizes: ['S', 'M', 'L'], cost: 3.6, ship: 1.3, priceGbp: 15.99, model: 'DROPSHIP', supplier: 'ae' },
  { title: "Women's High Waist Leggings", category: 'Activewear', brand: null, material: 'Nylon with elastane', colours: ['Black', 'Navy'], sizes: ['XS', 'S', 'M', 'L'], cost: 4.9, ship: 1.6, priceGbp: 19.99, model: 'DROPSHIP', supplier: 'ae' },
  { title: "Men's Linen Blend Short Sleeve Shirt", category: 'Shirts', brand: 'Rockstar', material: 'Linen-cotton blend', colours: ['White', 'Sky'], sizes: ['M', 'L', 'XL'], cost: 6.8, ship: 2.0, priceGbp: 24.99, model: 'DROPSHIP', supplier: 'cj' },
  { title: "Women's Oversized Denim Jacket", category: 'Jackets', brand: 'Rockstar', material: 'Cotton denim', colours: ['Mid Wash'], sizes: ['S', 'M', 'L'], cost: 12.5, ship: 4.3, priceGbp: 42.99, model: 'DROPSHIP', supplier: 'cj' },
  { title: "Women's Pleated Tennis Skirt", category: 'Skirts', brand: 'Rockstar', material: 'Polyester', colours: ['White', 'Black'], sizes: ['S', 'M', 'L'], cost: 4.1, ship: 1.5, priceGbp: 16.99, model: 'DROPSHIP', supplier: 'ae' },
  { title: 'Unisex Beanie Hat', category: 'Accessories', brand: 'Rockstar Basics', material: 'Acrylic knit', colours: ['Black', 'Mustard', 'Charcoal'], sizes: ['One Size'], cost: 1.4, ship: 0.8, priceGbp: 9.99, model: 'PHYSICAL', supplier: 'uk' },
  { title: "Men's Zip Through Track Jacket", category: 'Activewear', brand: 'Rockstar', material: 'Polyester tricot', colours: ['Black/White'], sizes: ['M', 'L', 'XL'], cost: 10.3, ship: 3.0, priceGbp: 36.99, model: 'DROPSHIP', supplier: 'cj' },
  { title: "Women's Lace Trim Cami Top", category: 'Tops', brand: 'Rockstar', material: 'Satin with lace trim', colours: ['Ivory', 'Black'], sizes: ['S', 'M', 'L'], cost: 3.8, ship: 1.4, priceGbp: 14.99, model: 'DROPSHIP', supplier: 'ae' },
  { title: "Women's Belted Trench Coat", category: 'Coats', brand: 'Rockstar', material: 'Polyester gabardine', colours: ['Beige'], sizes: ['S', 'M', 'L'], cost: 19.5, ship: 5.6, priceGbp: 64.99, model: 'DROPSHIP', supplier: 'cj' },
  { title: 'Canvas Tote Bag', category: 'Accessories', brand: 'Rockstar Basics', material: 'Cotton canvas', colours: ['Natural', 'Black'], sizes: ['One Size'], cost: 1.9, ship: 0.9, priceGbp: 11.99, model: 'PHYSICAL', supplier: 'uk' },
  { title: "Men's Cargo Shorts", category: 'Shorts', brand: 'Rockstar', material: 'Cotton twill', colours: ['Khaki', 'Black'], sizes: ['30', '32', '34', '36'], cost: 6.1, ship: 2.2, priceGbp: 21.99, model: 'DROPSHIP', supplier: 'ae' },
  // Deliberately thin margin so low-profit automation and reports have something to show.
  { title: "Women's Basic Crew Neck T-Shirt 3-Pack", category: 'T-Shirts', brand: 'Rockstar Basics', material: '100% cotton', colours: ['Mixed'], sizes: ['S', 'M', 'L'], cost: 7.9, ship: 2.9, priceGbp: 13.99, model: 'DROPSHIP', supplier: 'cj' },
];

const ACCOUNT_WEIGHTS: Record<MarketplaceCode, number> = { EBAY_UK: 0.42, AMAZON_UK: 0.28, TIKTOK_UK: 0.2, EBAY_US: 0.1 };
const FEE_PCT: Record<MarketplaceCode, number> = { EBAY_UK: 0.128, EBAY_US: 0.136, AMAZON_UK: 0.153, TIKTOK_UK: 0.09 };
const FIRST = ['Amelia', 'Olivia', 'Isla', 'Ava', 'Mia', 'Noah', 'Oliver', 'George', 'Leo', 'Harry', 'Sophie', 'Grace', 'Jack', 'Freya', 'Emily', 'Ethan', 'Chloe', 'Lucas'];
const LAST = ['Smith', 'Jones', 'Taylor', 'Brown', 'Williams', 'Wilson', 'Johnson', 'Davies', 'Patel', 'Wright', 'Walker', 'Khan', 'Evans', 'Thomas', 'Roberts', 'Green'];
const UK_TOWNS = [['Manchester', 'M1 1AE'], ['Leeds', 'LS1 4DY'], ['Bristol', 'BS1 5TR'], ['Birmingham', 'B1 1BB'], ['Glasgow', 'G1 1XQ'], ['Cardiff', 'CF10 1EP'], ['Brighton', 'BN1 1AE'], ['Norwich', 'NR1 3QU']];
const US_TOWNS = [['Austin', 'TX', '73301'], ['Denver', 'CO', '80202'], ['Columbus', 'OH', '43215'], ['Portland', 'OR', '97201']];
const DAY = 86_400_000;

export interface DemoBusinessOptions {
  days?: number;
  ordersPerDay?: number;
  seed?: number;
}

export async function seedDemoBusiness(app: INestApplicationContext, opts: DemoBusinessOptions = {}) {
  const prisma = app.get(PrismaService) as unknown as PrismaClient;
  const orders = app.get(OrdersService);
  const sync = app.get(SyncService);
  const inventory = app.get(InventoryService);
  const automation = app.get(AutomationService);
  const rand = rng(opts.seed ?? 20261014);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const days = opts.days ?? 90;
  const perDay = opts.ordersPerDay ?? 8;
  const now = Date.now();

  if (await prisma.order.count({ where: { account: { environment: 'DEMO' } } })) {
    log.log('Demo orders already exist; skipping (reset the database to regenerate).');
    return { skipped: true };
  }
  await seedDemo(prisma);
  const accounts = Object.fromEntries((await prisma.marketplaceAccount.findMany({ where: { environment: 'DEMO' } })).map((a) => [a.marketplace, a])) as unknown as Record<MarketplaceCode, { id: string; marketplace: MarketplaceCode }>;
  await prisma.currencyRate.create({ data: { base: 'USD', quote: 'GBP', rate: '0.79', asOf: new Date(now - (days + 30) * DAY), source: 'demo-manual' } });

  // ── Suppliers ──
  const supplier = {
    cj: await prisma.supplier.upsert({ where: { name: 'CJ Dropshipping (DEMO)' }, update: { shipsFromCountry: 'CN' }, create: { name: 'CJ Dropshipping (DEMO)', type: 'CJ_DROPSHIPPING', defaultCurrency: 'USD', shipsFromCountry: 'CN', processingDays: 2, deliveryDaysMin: 7, deliveryDaysMax: 12 } }),
    ae: await prisma.supplier.upsert({ where: { name: 'AliExpress Fashion Store (DEMO)' }, update: {}, create: { name: 'AliExpress Fashion Store (DEMO)', type: 'ALIEXPRESS', defaultCurrency: 'USD', shipsFromCountry: 'CN', processingDays: 3, deliveryDaysMin: 8, deliveryDaysMax: 15 } }),
    uk: await prisma.supplier.upsert({ where: { name: 'UK Apparel Wholesale (DEMO)' }, update: {}, create: { name: 'UK Apparel Wholesale (DEMO)', type: 'MANUAL', defaultCurrency: 'GBP', shipsFromCountry: 'GB', processingDays: 1, deliveryDaysMin: 1, deliveryDaysMax: 3, contactName: 'Sales desk', email: 'orders@example.com' } }),
  };

  // ── Catalogue, costs, stock ──
  const variants: Array<{ id: string; sku: string; productId: string; title: string; priceGbp: number; model: Model; weight: number }> = [];
  const existing = await prisma.productVariant.findMany({ include: { product: true } });
  for (const v of existing) {
    // Products from the small base demo: backdate their costs so historic orders have a cost in effect.
    await prisma.costRecord.updateMany({ where: { variantId: v.id, source: 'demo' }, data: { effectiveFrom: new Date(now - (days + 30) * DAY) } });
    variants.push({ id: v.id, sku: v.sku, productId: v.productId, title: v.product.title, priceGbp: 24.99, model: v.product.fulfilmentModel as Model, weight: 1 });
  }
  let pn = 20001;
  for (const p of CATALOGUE) {
    const product = await prisma.product.create({
      data: { title: p.title, description: `${p.title} in ${p.material.toLowerCase()}. DEMO product.`, category: p.category, brand: p.brand, status: 'ACTIVE', fulfilmentModel: p.model, countryOfOrigin: p.supplier === 'uk' ? 'BD' : 'CN' },
    });
    const popularity = 0.3 + rand() * 1.7;
    for (const colour of p.colours) {
      for (const size of p.sizes) {
        const sku = `FR-${pn}-${colour.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase()}-${size.replace(/\s+/g, '').toUpperCase()}`;
        const v = await prisma.productVariant.create({ data: { productId: product.id, sku, size, colour, material: p.material, weightGrams: 250 + Math.round(rand() * 600) } });
        await prisma.inventoryRecord.create({ data: { variantId: v.id, policy: p.model === 'PHYSICAL' ? 'AUTO_SYNC' : 'SUPPLIER_MONITOR' } });
        const s = supplier[p.supplier];
        const currency = p.supplier === 'uk' ? 'GBP' : 'USD';
        const sp = await prisma.supplierProduct.create({
          data: { supplierId: s.id, variantId: v.id, supplierSku: `${p.supplier.toUpperCase()}-${sku}`, supplierProductId: String(9_000_000 + pn), currentPrice: p.cost.toFixed(2), shippingCost: p.ship.toFixed(2), currency, stockStatus: rand() < 0.04 ? 'OUT_OF_STOCK' : 'IN_STOCK', reportedQuantity: 50 + Math.round(rand() * 500), stockCheckedAt: new Date(now - rand() * 30 * 3_600_000), stockSource: 'demo' },
        });
        const costBase = { variantId: v.id, currency, supplierShipping: p.ship.toFixed(2), packaging: '0.35', fxConversionPercent: currency === 'USD' ? '2.5' : '0', source: 'demo' };
        // 1 in 6 SKUs had a supplier price rise three weeks ago.
        const rise = rand() < 0.17;
        const changeAt = new Date(now - 21 * DAY);
        await prisma.costRecord.create({ data: { ...costBase, supplierPrice: p.cost.toFixed(2), effectiveFrom: new Date(now - (days + 30) * DAY), effectiveTo: rise ? changeAt : null, verifiedAt: new Date(now - (days + 30) * DAY) } });
        if (rise) {
          const np = (p.cost * 1.12).toFixed(2);
          await prisma.costRecord.create({ data: { ...costBase, supplierPrice: np, effectiveFrom: changeAt, notes: 'Supplier price increase (DEMO)' } });
          await prisma.supplierPriceHistory.create({ data: { supplierProductId: sp.id, price: np, shippingCost: p.ship.toFixed(2), currency, observedAt: changeAt, source: 'demo' } });
          await prisma.supplierProduct.update({ where: { id: sp.id }, data: { currentPrice: np } });
        }
        if (p.model === 'PHYSICAL') await inventory.move(v.id, { type: 'RECEIVE', quantity: 400, reason: 'Opening stock (DEMO)', location: 'MAIN' }, null);
        variants.push({ id: v.id, sku, productId: product.id, title: `${p.title} - ${colour} ${size}`, priceGbp: p.priceGbp, model: p.model, weight: popularity });
      }
    }
    pn++;
  }
  log.log(`Catalogue: ${variants.length} SKUs`);

  // ── Listings ──
  const listingFor = new Map<string, { id: string; sku: string; externalListingId: string }>(); // key: accountId|variantId
  let li = 0;
  for (const v of variants) {
    for (const mp of Object.keys(accounts) as MarketplaceCode[]) {
      if (mp === 'EBAY_US' && rand() < 0.5) continue;
      if (mp === 'TIKTOK_UK' && rand() < 0.25) continue;
      const acc = accounts[mp];
      if (await prisma.marketplaceListing.findUnique({ where: { accountId_sku: { accountId: acc.id, sku: v.sku } } })) continue;
      const usd = mp === 'EBAY_US';
      const price = usd ? Math.round(v.priceGbp * 1.35) - 0.01 : v.priceGbp;
      const roll = rand();
      const status = roll < 0.9 ? 'ACTIVE' : roll < 0.94 ? 'AWAITING_APPROVAL' : roll < 0.97 ? 'DRAFT' : 'PUBLICATION_FAILED';
      const live = status === 'ACTIVE';
      const externalListingId = live ? `DEMO-${mp}-${(100000 + li++).toString()}` : null;
      const listing = await prisma.marketplaceListing.create({
        data: { productId: v.productId, variantId: v.id, accountId: acc.id, marketplace: mp, status, sku: v.sku, externalListingId, price: price.toFixed(2), currency: usd ? 'USD' : 'GBP', quantity: live ? 10 : 0, lastPublishedAt: live ? new Date(now - (days + 5) * DAY) : null, lastError: status === 'PUBLICATION_FAILED' ? 'DEMO: The marketplace rejected the listing because a required item specific (Department) is missing.' : null },
      });
      const version = await prisma.listingVersion.create({
        data: {
          listingId: listing.id,
          version: 1,
          content: ListingContent.parse({ title: v.title.slice(0, mp.startsWith('EBAY') ? 80 : 200), description: `${v.title}. DEMO listing.`, condition: 'NEW', categoryId: 'demo-cat', categoryName: 'Clothing (DEMO)', dispatchTimeDays: v.model === 'PHYSICAL' ? 1 : 3, shippingPolicyId: 'demo-ship', returnPolicyId: 'demo-returns', quantityPolicy: 'SYNC', verifiedAttributes: ['Size', 'Colour'] }) as Prisma.InputJsonValue,
          submittedAt: status === 'DRAFT' ? null : new Date(now - (days + 6) * DAY),
          approvedAt: live || status === 'PUBLICATION_FAILED' ? new Date(now - (days + 6) * DAY) : null,
        },
      });
      await prisma.marketplaceListing.update({ where: { id: listing.id }, data: { currentVersionId: version.id, publishedVersionId: live ? version.id : null } });
      await prisma.listingStatusHistory.create({ data: { listingId: listing.id, fromStatus: 'DRAFT', toStatus: status, event: live ? 'PUBLISH_CONFIRMED' : 'DEMO_SEED', note: 'DEMO data' } });
      if (live) listingFor.set(`${acc.id}|${v.id}`, { id: listing.id, sku: v.sku, externalListingId: externalListingId! });
    }
  }
  log.log(`Listings: ${await prisma.marketplaceListing.count()}`);

  // ── Orders over the period ──
  const weighted: Array<[MarketplaceCode, number]> = Object.entries(ACCOUNT_WEIGHTS) as Array<[MarketplaceCode, number]>;
  const pickMp = () => {
    let r = rand();
    for (const [mp, w] of weighted) if ((r -= w) <= 0) return mp;
    return 'EBAY_UK' as MarketplaceCode;
  };
  const totalWeight = variants.reduce((s, v) => s + v.weight, 0);
  const pickVariant = () => {
    let r = rand() * totalWeight;
    for (const v of variants) if ((r -= v.weight) <= 0) return v;
    return variants[0]!;
  };
  const feeBatches = new Map<string, { fees: NonNullable<Parameters<SyncService['applyFinancials']>[1]>['fees']; refunds: Parameters<SyncService['applyFinancials']>[1]['refunds']; settledOrders: Parameters<SyncService['applyFinancials']>[1]['settledOrders'] }>();
  const batch = (accId: string) => {
    if (!feeBatches.has(accId)) feeBatches.set(accId, { fees: [], refunds: [], settledOrders: [] });
    return feeBatches.get(accId)!;
  };

  let count = 0;
  let seq = 1;
  for (let day = days; day >= 0; day--) {
    const weekend = new Date(now - day * DAY).getUTCDay() % 6 === 0;
    const trend = 0.75 + (0.5 * (days - day)) / days; // business growing over the period
    const n = Math.max(0, Math.round(perDay * trend * (weekend ? 1.3 : 1) * (0.6 + rand() * 0.8)));
    for (let k = 0; k < n; k++) {
      const mp = pickMp();
      const acc = accounts[mp];
      const usd = mp === 'EBAY_US';
      const linesN = rand() < 0.12 ? 2 : 1;
      const lines: NormalizedOrder['lines'] = [];
      for (let j = 0; j < linesN; j++) {
        let v = pickVariant();
        let listing = listingFor.get(`${acc.id}|${v.id}`);
        for (let tries = 0; !listing && tries < 10; tries++) {
          v = pickVariant();
          listing = listingFor.get(`${acc.id}|${v.id}`);
        }
        if (!listing || lines.some((l) => l.sku === listing!.sku)) continue;
        const unit = usd ? Math.round(v.priceGbp * 1.35) - 0.01 : v.priceGbp;
        const qty = rand() < 0.08 ? 2 : 1;
        const discount = rand() < 0.1 ? (unit * 0.1).toFixed(2) : '0';
        lines.push({ externalLineId: `L${seq}-${j}`, sku: listing.sku, title: v.title, quantity: qty, unitPrice: unit.toFixed(2), shippingCharged: usd ? '4.99' : rand() < 0.25 ? '2.99' : '0', sellerDiscount: discount, taxAmount: null, externalListingId: listing.externalListingId });
      }
      if (!lines.length) continue;
      const orderedAt = new Date(now - day * DAY - rand() * DAY * 0.9);
      const first = pick(FIRST);
      const last = pick(LAST);
      const town = usd ? pick(US_TOWNS) : pick(UK_TOWNS);
      const ext = `${mp.slice(0, 2)}-DEMO-${String(seq++).padStart(6, '0')}`;
      const cancelled = rand() < 0.015;
      const norm: NormalizedOrder = {
        externalOrderId: ext,
        status: cancelled ? 'CANCELLED' : 'PAID',
        orderedAt: orderedAt.toISOString(),
        dispatchBy: new Date(orderedAt.getTime() + (mp === 'AMAZON_UK' ? 2 : 3) * DAY).toISOString(),
        currency: usd ? 'USD' : 'GBP',
        pricesIncludeTax: !usd,
        taxCollectedByMarketplace: usd,
        lines,
        customer: { name: `${first} ${last}`, email: `${first}.${last}.${seq}@example.com`.toLowerCase(), line1: `${10 + Math.floor(rand() * 180)} High Street`, city: town[0], region: usd ? town[1] : undefined, postcode: usd ? town[2] : town[1], country: usd ? 'US' : 'GB' },
      };
      const { orderId } = await orders.ingest(acc.id, norm);
      count++;
      if (cancelled) continue;
      const ageDays = (now - orderedAt.getTime()) / DAY;
      const allPhysical = lines.every((l) => variants.find((v) => v.sku === l.sku)?.model === 'PHYSICAL');
      if (ageDays > 1.5) {
        const shippedAt = new Date(orderedAt.getTime() + (allPhysical ? 0.8 : 2.2) * DAY);
        const carrier = allPhysical ? (usd ? 'Royal Mail International' : 'Royal Mail') : pick(['Yanwen', 'YunExpress', '4PX']);
        await orders.recordShipment(orderId, { carrier, trackingNumber: `${carrier.slice(0, 2).toUpperCase()}${Math.floor(1e9 + rand() * 8e9)}GB`, shippedAt, labelCost: allPhysical ? (usd ? '6.20' : '2.85') : undefined, source: 'DEMO' }, null);
        const transit = allPhysical ? 2 : 9;
        if (ageDays > transit + 2.5) await orders.markDelivered(orderId, new Date(shippedAt.getTime() + transit * DAY), null);
      }
      // Marketplace fees post a few days after the sale; payouts settle after ~2 weeks.
      if (ageDays > 4) {
        const b = batch(acc.id);
        for (const l of lines) {
          const gross = (Number(l.unitPrice) * l.quantity + Number(l.shippingCharged) - Number(l.sellerDiscount)) * (1 + (usd ? 0.07 : 0));
          const fee = gross * FEE_PCT[mp] * (0.97 + rand() * 0.06);
          b.fees.push({ externalRef: `${ext}-${l.externalLineId}-fvf`, externalOrderId: ext, externalLineId: l.externalLineId, feeType: 'final_value', name: mp === 'AMAZON_UK' ? 'Referral fee' : mp === 'TIKTOK_UK' ? 'Commission fee' : 'Final value fee', amount: fee.toFixed(2), currency: norm.currency, postedAt: new Date(orderedAt.getTime() + 3 * DAY).toISOString(), settlementId: ageDays > 14 ? `S-${mp}-${Math.floor(ageDays / 14)}` : null });
        }
        if (mp.startsWith('EBAY')) b.fees.push({ externalRef: `${ext}-order-fee`, externalOrderId: ext, externalLineId: null, feeType: 'per_order', name: 'Per-order fee', amount: usd ? '0.30' : '0.30', currency: norm.currency, postedAt: new Date(orderedAt.getTime() + 3 * DAY).toISOString() });
        if (mp === 'TIKTOK_UK') b.fees.push({ externalRef: `${ext}-txn`, externalOrderId: ext, externalLineId: null, feeType: 'transaction', name: 'Transaction fee', amount: '0.25', currency: 'GBP', postedAt: new Date(orderedAt.getTime() + 3 * DAY).toISOString() });
        if (ageDays > 14) b.settledOrders.push({ externalOrderId: ext, settlementId: `S-${mp}-${Math.floor(ageDays / 14)}`, settledAt: new Date(orderedAt.getTime() + 14 * DAY).toISOString() });
        // ~4% refunded (some after a return), mostly full refunds.
        if (ageDays > 12 && rand() < 0.04) {
          const l = lines[0]!;
          const full = rand() < 0.75;
          const amount = full ? Number(l.unitPrice) * l.quantity : Number(l.unitPrice) * 0.3;
          b.refunds.push({ externalRefundId: `${ext}-R1`, externalOrderId: ext, externalLineId: l.externalLineId, amount: amount.toFixed(2), taxAmount: null, currency: norm.currency, refundedAt: new Date(orderedAt.getTime() + 11 * DAY).toISOString(), reason: full ? pick(['Item not as described', 'Wrong size', 'Changed mind']) : 'Partial refund: minor defect' });
          if (full) {
            const received = rand() < 0.7;
            await prisma.return.create({ data: { orderId, status: received ? 'RECEIVED' : 'IN_TRANSIT', reason: pick(['Wrong size', 'Not as pictured', 'Changed mind']), currency: norm.currency, returnShippingCost: mp === 'AMAZON_UK' ? '3.20' : null, restockable: received ? true : null, receivedAt: received ? new Date(orderedAt.getTime() + 10 * DAY) : null } });
          }
        }
      }
    }
    if (day % 15 === 0) log.log(`Orders generated: ${count} (day -${day})`);
  }

  // Reconcile fees, refunds and settlements through the same path as live finance sync.
  for (const [accId, b] of feeBatches) await sync.applyFinancials(accId, { ...b, cursor: null });
  log.log(`Orders: ${count}; fees and settlements reconciled`);

  // ── Operating expenses ──
  const months = Math.ceil(days / 30) + 1;
  for (let m = 0; m < months; m++) {
    const date = new Date(now - m * 30 * DAY);
    const e = (category: string, description: string, amount: string, extra: Partial<Prisma.ExpenseUncheckedCreateInput> = {}) =>
      prisma.expense.create({ data: { date, category, description: `${description} (DEMO)`, amount, currency: 'GBP', ...extra } });
    await e('SOFTWARE', 'Listing and inventory tools', '79.00');
    await e('ACCOUNTANCY', 'Monthly bookkeeping', '150.00');
    await e('PACKAGING', 'Mailing bags and labels', (55 + rand() * 30).toFixed(2));
    await e('ADVERTISING', 'eBay promoted listings', (180 + rand() * 90).toFixed(2), { marketplace: 'EBAY_UK' });
    await e('ADVERTISING', 'Amazon sponsored products', (220 + rand() * 120).toFixed(2), { marketplace: 'AMAZON_UK' });
    await e('ADVERTISING', 'TikTok Shop affiliate commissions', (90 + rand() * 60).toFixed(2), { marketplace: 'TIKTOK_UK' });
    await e('STORAGE', 'Small unit rental', '240.00');
    await e('BANK_CHARGES', 'Business account and card fees', (12 + rand() * 8).toFixed(2));
  }

  // ── Automation rules (pausing rules stay approval-gated) ──
  const rules: Array<z.input<typeof RuleInput>> = [
    { name: 'Low-margin live listings', kind: 'LOW_PROFIT_LISTINGS', conditions: { minMarginPercent: 15 }, action: 'PROPOSE_REPRICE', notifyRole: 'owner', everyMinutes: 360, enabled: true, requiresApproval: true },
    { name: 'Supplier out of stock', kind: 'SUPPLIER_OUT_OF_STOCK', conditions: {}, action: 'PAUSE_LISTINGS', notifyRole: 'owner', everyMinutes: 60, enabled: true, requiresApproval: true },
    { name: 'Supplier price rises > 5%', kind: 'SUPPLIER_COST_INCREASE', conditions: { percent: 5, withinHours: 24 }, action: 'NOTIFY', notifyRole: 'owner', everyMinutes: 360, enabled: true, requiresApproval: true },
    { name: 'Dispatch due within 24h', kind: 'DISPATCH_DEADLINE', conditions: { withinHours: 24 }, action: 'NOTIFY', notifyRole: 'order_manager', everyMinutes: 60, enabled: true, requiresApproval: true },
    { name: 'Daily sales summary', kind: 'DAILY_SALES_REPORT', conditions: {}, action: 'NOTIFY', notifyRole: 'owner', everyMinutes: 1440, enabled: true, requiresApproval: true },
  ];
  const system = { userId: null, email: 'demo-seed', ip: null, userAgent: null } as unknown as AuthContext;
  for (const r of rules) await automation.create(RuleInput.parse(r), system);

  const summary = {
    skus: variants.length,
    listings: await prisma.marketplaceListing.count(),
    orders: await prisma.order.count(),
    fees: await prisma.actualFee.count(),
    refunds: await prisma.refund.count(),
    expenses: await prisma.expense.count(),
  };
  log.log(`Demo business ready: ${JSON.stringify(summary)}`);
  return summary;
}
