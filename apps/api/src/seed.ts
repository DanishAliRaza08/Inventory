import { PrismaClient } from '@prisma/client';
import { hash } from '@node-rs/argon2';
import { DEFAULT_ROLES, MARKETPLACES, MARKETPLACE_CODES, PERMISSIONS } from '@fr/core';

/** Idempotent base seed: permission catalogue, system roles and one marketplace account per channel. */
export async function seedBase(prisma: PrismaClient) {
  for (const [key, description] of Object.entries(PERMISSIONS)) {
    await prisma.permission.upsert({ where: { key }, update: { description }, create: { key, description } });
  }
  for (const r of DEFAULT_ROLES) {
    const role = await prisma.role.upsert({
      where: { key: r.key },
      update: { name: r.name, description: r.description, requiresMfa: r.requiresMfa, isSystem: true },
      create: { key: r.key, name: r.name, description: r.description, requiresMfa: r.requiresMfa, isSystem: true },
    });
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({ data: r.permissions.map((p) => ({ roleId: role.id, permissionKey: p })) });
  }
  for (const code of MARKETPLACE_CODES) {
    await prisma.marketplaceAccount.upsert({
      where: { marketplace_name: { marketplace: code, name: `${MARKETPLACES[code].name} (main)` } },
      update: {},
      create: { marketplace: code, name: `${MARKETPLACES[code].name} (main)`, environment: 'PRODUCTION', status: 'NOT_CONNECTED' },
    });
  }
}

export async function upsertUser(prisma: PrismaClient, email: string, name: string, password: string, roleKeys: string[]) {
  const passwordHash = await hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
  const roles = await prisma.role.findMany({ where: { key: { in: roleKeys } } });
  const user = await prisma.user.upsert({ where: { email }, update: {}, create: { email, name, passwordHash } });
  for (const role of roles) {
    await prisma.userRole.upsert({ where: { userId_roleId: { userId: user.id, roleId: role.id } }, update: {}, create: { userId: user.id, roleId: role.id } });
  }
  return user;
}

/**
 * Demonstration data. Everything is labelled DEMO: example fee rates are NOT the
 * marketplaces' actual fees and the demo accounts never contact a marketplace.
 */
export async function seedDemo(prisma: PrismaClient) {
  for (const code of MARKETPLACE_CODES) {
    await prisma.marketplaceAccount.upsert({
      where: { marketplace_name: { marketplace: code, name: `${MARKETPLACES[code].name} (DEMO)` } },
      update: {},
      create: { marketplace: code, name: `${MARKETPLACES[code].name} (DEMO)`, environment: 'DEMO', status: 'CONNECTED', connectedAt: new Date() },
    });
  }
  if ((await prisma.feeRule.count()) === 0) {
    const demo = 'DEMO example rate — replace with the rates on your marketplace account.';
    await prisma.feeRule.createMany({
      data: [
        { name: 'DEMO selling fee', marketplace: 'EBAY_UK', feeType: 'final_value', basis: 'order_total_incl_tax', currency: 'GBP', percent: '12', overrideGroup: 'fvf', notes: demo },
        { name: 'DEMO per-order fee', marketplace: 'EBAY_UK', feeType: 'per_order', basis: 'per_order', currency: 'GBP', fixed: '0.30', notes: demo },
        { name: 'DEMO selling fee', marketplace: 'EBAY_US', feeType: 'final_value', basis: 'order_total_incl_tax', currency: 'USD', percent: '13', overrideGroup: 'fvf', notes: demo },
        { name: 'DEMO per-order fee', marketplace: 'EBAY_US', feeType: 'per_order', basis: 'per_order', currency: 'USD', fixed: '0.30', notes: demo },
        { name: 'DEMO referral fee', marketplace: 'AMAZON_UK', feeType: 'final_value', basis: 'order_total_incl_tax', currency: 'GBP', percent: '15', notes: demo },
        { name: 'DEMO commission', marketplace: 'TIKTOK_UK', feeType: 'final_value', basis: 'order_total_incl_tax', currency: 'GBP', percent: '9', notes: demo },
      ],
    });
  }
  if ((await prisma.currencyRate.count()) === 0) {
    await prisma.currencyRate.create({ data: { base: 'USD', quote: 'GBP', rate: '0.79', asOf: new Date(Date.now() - 3_600_000), source: 'demo-manual' } });
  }
  if ((await prisma.product.count()) === 0) {
    const supplier = await prisma.supplier.upsert({ where: { name: 'CJ Dropshipping (DEMO)' }, update: {}, create: { name: 'CJ Dropshipping (DEMO)', type: 'CJ_DROPSHIPPING', defaultCurrency: 'USD', processingDays: 2, deliveryDaysMin: 7, deliveryDaysMax: 12 } });
    const items = [
      { title: "Women's Floral Summer Midi Dress", category: 'Dresses', colour: 'Blue', sizes: ['10', '12', '14'], cost: '6.50', ship: '2.10' },
      { title: "Men's Slim Fit Linen Shirt", category: 'Shirts', colour: 'White', sizes: ['M', 'L'], cost: '5.20', ship: '1.80' },
      { title: 'Unisex Oversized Hoodie', category: 'Hoodies', colour: 'Black', sizes: ['S', 'M', 'L'], cost: '9.80', ship: '3.40' },
    ];
    let n = 10001;
    for (const it of items) {
      const product = await prisma.product.create({ data: { title: it.title, description: `${it.title}. Demonstration product.`, category: it.category, status: 'ACTIVE', fulfilmentModel: 'DROPSHIP' } });
      for (const size of it.sizes) {
        const v = await prisma.productVariant.create({ data: { productId: product.id, sku: `FR-${n}-${size}`, size, colour: it.colour, material: 'Polyester' } });
        await prisma.inventoryRecord.create({ data: { variantId: v.id } });
        await prisma.supplierProduct.create({
          data: { supplierId: supplier.id, variantId: v.id, currentPrice: it.cost, shippingCost: it.ship, currency: 'USD', stockStatus: 'IN_STOCK', reportedQuantity: 200, stockCheckedAt: new Date(), stockSource: 'demo' },
        });
        await prisma.costRecord.create({ data: { variantId: v.id, effectiveFrom: new Date(Date.now() - 86_400_000), currency: 'USD', supplierPrice: it.cost, supplierShipping: it.ship, packaging: '0.25', fxConversionPercent: '2.5', source: 'demo' } });
      }
      n++;
    }
  }
}
