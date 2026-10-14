/**
 * Bulk-generates the documented capacity target in an EMPTY, NON-PRODUCTION database:
 * 20,000 products (60,000 SKUs), 100,000 marketplace listings and 100,000 orders in the last
 * 30 days with current profit calculations. Rows are inserted with set-based SQL (seconds, not
 * hours) and are labelled "Load product …" / LT- SKUs so they are obviously synthetic.
 *
 *   DATABASE_URL=postgresql://…/fr_load DEMO_MODE=true pnpm --filter @fr/api load:data
 *
 * Then run `pnpm --filter @fr/api load:test` against an API pointed at the same database.
 */
import { PrismaClient } from '@prisma/client';
import { seedBase, seedDemo } from '../src/seed';

const PRODUCTS = Number(process.env.LOAD_PRODUCTS ?? 20_000);
const LISTINGS = Number(process.env.LOAD_LISTINGS ?? 100_000);
const ORDERS = Number(process.env.LOAD_ORDERS ?? 100_000);

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to generate load data in production.');
  const prisma = new PrismaClient();
  if (await prisma.product.count({ where: { title: { startsWith: 'Load product' } } })) throw new Error('Load data already present in this database.');
  await seedBase(prisma);
  await seedDemo(prisma); // DEMO accounts, demo fee rules, FX rate
  const step = async (label: string, sql: string) => {
    const t = Date.now();
    const n = await prisma.$executeRawUnsafe(sql);
    console.log(`${label}: ${n} rows in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  };

  await step('products', `
    INSERT INTO products (id, title, description, category, brand, status, fulfilment_model, updated_at)
    SELECT gen_random_uuid(),
           'Load product ' || g || ' ' || (ARRAY['Midi Dress','Linen Shirt','Fleece Hoodie','Pleated Skirt','Denim Jacket','Wide Leg Trousers'])[1 + g % 6],
           'Synthetic load-test product.', (ARRAY['Dresses','Shirts','Hoodies','Skirts','Jackets','Trousers'])[1 + g % 6], 'Rockstar',
           'ACTIVE'::"ProductStatus", (CASE WHEN g % 4 = 0 THEN 'PHYSICAL' ELSE 'DROPSHIP' END)::"FulfilmentModel", now()
    FROM generate_series(1, ${PRODUCTS}) g`);
  await step('variants', `
    INSERT INTO product_variants (id, product_id, sku, size, colour, material, updated_at)
    SELECT gen_random_uuid(), p.id, 'LT-' || p.product_number || '-' || s, s, 'Black', 'Polyester', now()
    FROM products p CROSS JOIN unnest(ARRAY['S','M','L']) s WHERE p.title LIKE 'Load product %'`);
  await step('costs', `
    INSERT INTO cost_records (id, variant_id, effective_from, currency, supplier_price, supplier_shipping, packaging, source, verified_at)
    SELECT gen_random_uuid(), v.id, now() - interval '400 days', 'GBP', 6 + (abs(hashtext(v.sku)) % 900) / 100.0, 2, 0.35, 'load-test', now()
    FROM product_variants v WHERE v.sku LIKE 'LT-%'`);
  await step('inventory', `
    INSERT INTO inventory_records (id, variant_id, available, updated_at)
    SELECT gen_random_uuid(), v.id, CASE WHEN p.fulfilment_model = 'PHYSICAL' THEN 50 ELSE 0 END, now()
    FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.sku LIKE 'LT-%'`);
  await step('listings', `
    WITH v AS (SELECT id vid, product_id pid, sku, row_number() OVER (ORDER BY sku) rn FROM product_variants WHERE sku LIKE 'LT-%'),
         a AS (SELECT id aid, marketplace, row_number() OVER (ORDER BY marketplace) an FROM marketplace_accounts WHERE environment = 'DEMO')
    INSERT INTO marketplace_listings (id, product_id, variant_id, account_id, marketplace, status, sku, external_listing_id, price, currency, quantity, last_published_at, updated_at)
    SELECT gen_random_uuid(), v.pid, v.vid, a.aid, a.marketplace, 'ACTIVE'::"ListingStatus", v.sku, 'LT-' || a.an || '-' || v.rn,
           CASE WHEN a.marketplace = 'EBAY_US' THEN 32.99 ELSE 24.99 END, CASE WHEN a.marketplace = 'EBAY_US' THEN 'USD' ELSE 'GBP' END, 10, now() - interval '60 days', now()
    FROM v JOIN a ON (v.rn + a.an) % 4 < 2
    ORDER BY v.rn, a.an LIMIT ${LISTINGS}`);
  await step('listing versions', `
    INSERT INTO listing_versions (id, listing_id, version, content, approved_at)
    SELECT gen_random_uuid(), l.id, 1, jsonb_build_object('title', p.title || ' Black ' || v.size, 'description', p.description, 'condition', 'NEW',
             'categoryId', 'load', 'dispatchTimeDays', 3, 'shippingPolicyId', 'ship', 'returnPolicyId', 'ret', 'quantityPolicy', 'SYNC'), now() - interval '61 days'
    FROM marketplace_listings l JOIN product_variants v ON v.id = l.variant_id JOIN products p ON p.id = l.product_id
    WHERE l.external_listing_id LIKE 'LT-%'`);
  await step('listing → version', `
    UPDATE marketplace_listings l SET current_version_id = lv.id, published_version_id = lv.id
    FROM listing_versions lv WHERE lv.listing_id = l.id AND l.external_listing_id LIKE 'LT-%'`);

  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS lt_orders`);
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS lt_listings`);
  await step('listing index', `
    CREATE UNLOGGED TABLE lt_listings AS
    SELECT id lid, account_id, marketplace, variant_id, sku, currency, price, row_number() OVER (ORDER BY id) rn
    FROM marketplace_listings WHERE external_listing_id LIKE 'LT-%'`);
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX ON lt_listings (rn)`);
  await prisma.$executeRawUnsafe(`ANALYZE lt_listings`);
  await step('order plan', `
    CREATE UNLOGGED TABLE lt_orders AS
    SELECT gen_random_uuid() oid, gen_random_uuid() lnid, g, l.*, now() - (g::float / ${ORDERS}) * interval '30 days' AS ordered_at
    FROM generate_series(1, ${ORDERS}) g
    JOIN lt_listings l ON l.rn = 1 + ((g::bigint * 7919) % (SELECT count(*) FROM lt_listings))`);
  await step('orders', `
    INSERT INTO orders (id, account_id, marketplace, external_order_id, status, ordered_at, dispatch_by, currency, prices_include_tax, tax_treatment, settled, updated_at)
    SELECT oid, account_id, marketplace, 'LT-ORDER-' || g, CASE WHEN ordered_at < now() - interval '4 days' THEN 'DELIVERED' ELSE 'PAID' END,
           ordered_at, ordered_at + interval '3 days', currency, marketplace <> 'EBAY_US',
           CASE WHEN marketplace = 'EBAY_US' THEN 'marketplace_collected' ELSE 'seller_liable' END, ordered_at < now() - interval '14 days', now()
    FROM lt_orders`);
  await step('order lines', `
    INSERT INTO order_lines (id, order_id, external_line_id, variant_id, listing_id, sku, title, quantity, unit_price, cost_record_id)
    SELECT o.lnid, o.oid, 'L1', o.variant_id, o.lid, o.sku, 'Load test item ' || o.sku, 1, o.price, c.id
    FROM lt_orders o JOIN cost_records c ON c.variant_id = o.variant_id`);
  await step('profit', `
    INSERT INTO profit_calculations (id, order_line_id, status, currency, net_revenue, total_cost, total_fees, net_profit, margin_percent, reporting_currency, reporting_net_profit, breakdown, is_current)
    SELECT gen_random_uuid(), o.lnid,
           CASE WHEN o.ordered_at < now() - interval '14 days' THEN 'confirmed' WHEN o.ordered_at < now() - interval '4 days' THEN 'partially_reconciled' ELSE 'estimated' END,
           o.currency, x.rev, x.cost, x.fees, x.rev - x.cost - x.fees, round((x.rev - x.cost - x.fees) / x.rev * 100, 4), 'GBP', round((x.rev - x.cost - x.fees) * CASE WHEN o.currency = 'USD' THEN 0.79 ELSE 1 END, 4),
           jsonb_build_object('netRevenue', x.rev::text, 'netProfit', (x.rev - x.cost - x.fees)::text, 'marketplaceFees', x.fees::text, 'paymentFees', '0',
                              'totalProductCost', x.cost::text, 'warnings', '[]'::jsonb, 'reporting', jsonb_build_object('currency', 'GBP', 'rate', CASE WHEN o.currency = 'USD' THEN '0.79' ELSE '1' END)),
           true
    FROM lt_orders o JOIN cost_records c ON c.variant_id = o.variant_id
    CROSS JOIN LATERAL (SELECT round(CASE WHEN o.currency = 'USD' THEN o.price ELSE o.price / 1.2 END, 4) rev,
                               round(c.supplier_price + c.supplier_shipping + c.packaging, 4) cost,
                               round(o.price * 0.13, 4) fees) x`);
  await prisma.$executeRawUnsafe(`DROP TABLE lt_orders`);
  await prisma.$executeRawUnsafe(`DROP TABLE lt_listings`);
  await prisma.$executeRawUnsafe(`ANALYZE`);
  console.log('Load data ready.');
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
