import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Decimal, MarketplaceCode, estimateFees, money } from '@fr/core';
import { ProfitService } from '../finance/profit.service';
import { RepricingService } from '../listings/repricing.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';

export interface ReportFilter {
  from: Date;
  to: Date;
  marketplace?: string;
}

type Col = { key: string; label: string; type?: 'money' | 'percent' | 'number' | 'text' | 'date' };

export const REPORTS: Record<string, { title: string; columns: Col[] }> = {
  sales_by_marketplace: { title: 'Sales and profit by marketplace', columns: [{ key: 'marketplace', label: 'Marketplace' }, { key: 'orders', label: 'Orders', type: 'number' }, { key: 'units', label: 'Units', type: 'number' }, { key: 'revenue', label: 'Net revenue', type: 'money' }, { key: 'fees', label: 'Fees', type: 'money' }, { key: 'profit', label: 'Net profit', type: 'money' }, { key: 'margin', label: 'Margin', type: 'percent' }] },
  profit_by_sku: { title: 'Profit by SKU', columns: [{ key: 'sku', label: 'SKU' }, { key: 'title', label: 'Product' }, { key: 'units', label: 'Units', type: 'number' }, { key: 'revenue', label: 'Net revenue', type: 'money' }, { key: 'profit', label: 'Net profit', type: 'money' }, { key: 'margin', label: 'Margin', type: 'percent' }] },
  profit_by_category: { title: 'Profit by category', columns: [{ key: 'category', label: 'Category' }, { key: 'units', label: 'Units', type: 'number' }, { key: 'revenue', label: 'Net revenue', type: 'money' }, { key: 'profit', label: 'Net profit', type: 'money' }, { key: 'margin', label: 'Margin', type: 'percent' }] },
  profit_by_supplier: { title: 'Profit by supplier', columns: [{ key: 'supplier', label: 'Supplier' }, { key: 'units', label: 'Units', type: 'number' }, { key: 'revenue', label: 'Net revenue', type: 'money' }, { key: 'profit', label: 'Net profit', type: 'money' }, { key: 'margin', label: 'Margin', type: 'percent' }] },
  profit_by_order: { title: 'Profit by order', columns: [{ key: 'order', label: 'Order' }, { key: 'marketplace', label: 'Marketplace' }, { key: 'date', label: 'Date', type: 'date' }, { key: 'revenue', label: 'Net revenue', type: 'money' }, { key: 'profit', label: 'Net profit', type: 'money' }, { key: 'status', label: 'Data status' }] },
  low_margin_listings: { title: 'Low-margin live listings', columns: [{ key: 'sku', label: 'SKU' }, { key: 'marketplace', label: 'Marketplace' }, { key: 'currentPrice', label: 'Price', type: 'money' }, { key: 'currentProfit', label: 'Profit per sale', type: 'money' }, { key: 'currentMarginPercent', label: 'Margin', type: 'percent' }, { key: 'proposedPrice', label: 'Proposed price', type: 'money' }, { key: 'reason', label: 'Reason' }] },
  loss_making_products: { title: 'Loss-making SKUs', columns: [{ key: 'sku', label: 'SKU' }, { key: 'title', label: 'Product' }, { key: 'units', label: 'Units', type: 'number' }, { key: 'profit', label: 'Net profit', type: 'money' }] },
  best_sellers: { title: 'Best-selling SKUs', columns: [{ key: 'sku', label: 'SKU' }, { key: 'title', label: 'Product' }, { key: 'units', label: 'Units', type: 'number' }, { key: 'revenue', label: 'Net revenue', type: 'money' }, { key: 'profit', label: 'Net profit', type: 'money' }] },
  slow_moving_stock: { title: 'Slow-moving physical stock', columns: [{ key: 'sku', label: 'SKU' }, { key: 'title', label: 'Product' }, { key: 'available', label: 'On hand', type: 'number' }, { key: 'unitsSold', label: 'Units sold in period', type: 'number' }, { key: 'stockValue', label: 'Stock value at cost', type: 'money' }] },
  supplier_stock_failures: { title: 'Supplier stock problems', columns: [{ key: 'supplier', label: 'Supplier' }, { key: 'skus', label: 'SKUs supplied', type: 'number' }, { key: 'outOfStock', label: 'Out of stock / discontinued', type: 'number' }, { key: 'stale', label: 'Stock data > 48h old', type: 'number' }] },
  publication_success: { title: 'Listing publication success rate', columns: [{ key: 'marketplace', label: 'Marketplace' }, { key: 'attempted', label: 'Attempted', type: 'number' }, { key: 'succeeded', label: 'Succeeded', type: 'number' }, { key: 'failed', label: 'Failed', type: 'number' }, { key: 'rate', label: 'Success rate', type: 'percent' }] },
  awaiting_fulfilment: { title: 'Orders awaiting fulfilment', columns: [{ key: 'order', label: 'Order' }, { key: 'marketplace', label: 'Marketplace' }, { key: 'date', label: 'Ordered', type: 'date' }, { key: 'dispatchBy', label: 'Dispatch by', type: 'date' }, { key: 'fulfilment', label: 'Fulfilment' }] },
  returns_refund_rate: { title: 'Returns and refund rate', columns: [{ key: 'marketplace', label: 'Marketplace' }, { key: 'orders', label: 'Orders', type: 'number' }, { key: 'refundedOrders', label: 'Refunded orders', type: 'number' }, { key: 'refunded', label: 'Amount refunded', type: 'money' }, { key: 'rate', label: 'Refund rate', type: 'percent' }] },
  fees_actual_vs_estimated: { title: 'Actual vs estimated marketplace fees', columns: [{ key: 'marketplace', label: 'Marketplace' }, { key: 'reconciledLines', label: 'Reconciled lines', type: 'number' }, { key: 'estimated', label: 'Estimated (fee rules)', type: 'money' }, { key: 'actual', label: 'Actual', type: 'money' }, { key: 'variance', label: 'Variance', type: 'percent' }] },
  operating_expenses: { title: 'Operating expenses', columns: [{ key: 'category', label: 'Category' }, { key: 'count', label: 'Entries', type: 'number' }, { key: 'amount', label: 'Amount', type: 'money' }] },
  monthly_operating_profit: { title: 'Monthly operating profit', columns: [{ key: 'month', label: 'Month' }, { key: 'revenue', label: 'Net revenue', type: 'money' }, { key: 'contribution', label: 'Contribution profit', type: 'money' }, { key: 'expenses', label: 'Operating expenses', type: 'money' }, { key: 'operatingProfit', label: 'Operating profit', type: 'money' }] },
};

const n = (v: unknown) => Number(v ?? 0);
const r2 = (v: unknown) => n(v).toFixed(2);
const pct = (a: unknown, b: unknown) => (n(b) ? ((n(a) / n(b)) * 100).toFixed(1) : null);

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly profit: ProfitService,
    private readonly repricing: RepricingService,
  ) {}

  /** Current profit lines in the period, in the reporting currency at the rate stored on each calculation. */
  private lines(f: ReportFilter) {
    const mp = f.marketplace ? Prisma.sql`AND o.marketplace::text = ${f.marketplace}` : Prisma.empty;
    return Prisma.sql`
      SELECT o.id AS order_id, o.order_number, o.external_order_id, o.marketplace::text AS marketplace, o.ordered_at, ol.sku, ol.quantity, ol.variant_id, ol.title,
        pc.status,
        COALESCE((pc.breakdown->'reporting'->>'rate')::numeric, 1) AS rate,
        (pc.breakdown->>'netRevenue')::numeric * COALESCE((pc.breakdown->'reporting'->>'rate')::numeric, 1) AS revenue,
        (pc.breakdown->>'netProfit')::numeric * COALESCE((pc.breakdown->'reporting'->>'rate')::numeric, 1) AS profit,
        ((pc.breakdown->>'marketplaceFees')::numeric + (pc.breakdown->>'paymentFees')::numeric) * COALESCE((pc.breakdown->'reporting'->>'rate')::numeric, 1) AS fees
      FROM orders o JOIN order_lines ol ON ol.order_id = o.id JOIN profit_calculations pc ON pc.order_line_id = ol.id AND pc.is_current
      WHERE o.ordered_at >= ${f.from} AND o.ordered_at < ${f.to} ${mp}`;
  }

  private async dataStatus(f: ReportFilter) {
    const rows = await this.prisma.$queryRaw<Array<{ status: string; c: number }>>`SELECT status, COUNT(*)::int AS c FROM (${this.lines(f)}) l GROUP BY status`;
    const counts = Object.fromEntries(rows.map((r) => [r.status, r.c])) as Record<string, number>;
    const total = rows.reduce((a, r) => a + r.c, 0);
    const label = !total ? 'No order data' : counts.confirmed === total ? 'Confirmed (settled)' : (counts.estimated ?? 0) === total ? 'Estimated' : 'Partially reconciled';
    return { label, counts, total };
  }

  async run(key: string, f: ReportFilter) {
    const def = REPORTS[key];
    if (!def) throw new BadRequestException({ code: 'UNKNOWN_REPORT', message: `Unknown report ${key}` });
    const currency = await this.settings.get('finance.reporting_currency');
    const L = this.lines(f);
    let rows: Array<Record<string, unknown>> = [];
    switch (key) {
      case 'sales_by_marketplace':
        rows = (await this.prisma.$queryRaw<any[]>`SELECT marketplace, COUNT(DISTINCT order_id)::int AS orders, SUM(quantity)::int AS units, SUM(revenue) AS revenue, SUM(fees) AS fees, SUM(profit) AS profit FROM (${L}) l GROUP BY 1 ORDER BY profit DESC`).map((r) => ({ ...r, revenue: r2(r.revenue), fees: r2(r.fees), profit: r2(r.profit), margin: pct(r.profit, r.revenue) }));
        break;
      case 'profit_by_sku':
      case 'best_sellers':
      case 'loss_making_products': {
        const raw = await this.prisma.$queryRaw<any[]>`SELECT sku, MAX(title) AS title, SUM(quantity)::int AS units, SUM(revenue) AS revenue, SUM(profit) AS profit FROM (${L}) l GROUP BY sku`;
        rows = raw.map((r) => ({ ...r, revenue: r2(r.revenue), profit: r2(r.profit), margin: pct(r.profit, r.revenue) }));
        if (key === 'best_sellers') rows = rows.sort((a, b) => n(b.units) - n(a.units)).slice(0, 100);
        else if (key === 'loss_making_products') rows = rows.filter((r) => n(r.profit) < 0).sort((a, b) => n(a.profit) - n(b.profit));
        else rows = rows.sort((a, b) => n(b.profit) - n(a.profit));
        break;
      }
      case 'profit_by_category':
        rows = (await this.prisma.$queryRaw<any[]>`SELECT COALESCE(p.category, 'Uncategorised') AS category, SUM(l.quantity)::int AS units, SUM(l.revenue) AS revenue, SUM(l.profit) AS profit FROM (${L}) l LEFT JOIN product_variants v ON v.id = l.variant_id LEFT JOIN products p ON p.id = v.product_id GROUP BY 1 ORDER BY profit DESC`).map((r) => ({ ...r, revenue: r2(r.revenue), profit: r2(r.profit), margin: pct(r.profit, r.revenue) }));
        break;
      case 'profit_by_supplier':
        rows = (await this.prisma.$queryRaw<any[]>`SELECT COALESCE(s.name, 'Own stock / none') AS supplier, SUM(l.quantity)::int AS units, SUM(l.revenue) AS revenue, SUM(l.profit) AS profit FROM (${L}) l LEFT JOIN supplier_products sp ON sp.variant_id = l.variant_id AND sp.priority = 1 LEFT JOIN suppliers s ON s.id = sp.supplier_id GROUP BY 1 ORDER BY profit DESC`).map((r) => ({ ...r, revenue: r2(r.revenue), profit: r2(r.profit), margin: pct(r.profit, r.revenue) }));
        break;
      case 'profit_by_order':
        rows = (await this.prisma.$queryRaw<any[]>`SELECT order_number, external_order_id, marketplace, MIN(ordered_at) AS date, SUM(revenue) AS revenue, SUM(profit) AS profit, MIN(status) AS status FROM (${L}) l GROUP BY 1, 2, 3 ORDER BY date DESC LIMIT 2000`).map((r) => ({ order: `#${r.order_number} (${r.external_order_id})`, marketplace: r.marketplace, date: r.date, revenue: r2(r.revenue), profit: r2(r.profit), status: r.status }));
        break;
      case 'low_margin_listings':
        rows = (await this.repricing.proposals(500)).filter((p) => !f.marketplace || p.marketplace === f.marketplace);
        break;
      case 'slow_moving_stock':
        rows = (await this.prisma.$queryRaw<any[]>`
          SELECT v.sku, p.title, i.available, COALESCE(s.units, 0)::int AS units_sold, i.available * COALESCE(c.supplier_price + c.supplier_shipping, 0) AS stock_value
          FROM inventory_records i JOIN product_variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id
          LEFT JOIN cost_records c ON c.variant_id = v.id AND c.effective_to IS NULL
          LEFT JOIN (SELECT variant_id, SUM(quantity) AS units FROM (${L}) l GROUP BY variant_id) s ON s.variant_id = v.id
          WHERE p.fulfilment_model = 'PHYSICAL' AND i.available > 0 AND COALESCE(s.units, 0) <= GREATEST(1, i.available / 10)
          ORDER BY stock_value DESC NULLS LAST LIMIT 500`).map((r) => ({ sku: r.sku, title: r.title, available: r.available, unitsSold: r.units_sold, stockValue: r2(r.stock_value) }));
        break;
      case 'supplier_stock_failures':
        rows = await this.prisma.$queryRaw<any[]>`
          SELECT s.name AS supplier, COUNT(sp.id)::int AS skus,
            COUNT(*) FILTER (WHERE sp.stock_status IN ('OUT_OF_STOCK', 'DISCONTINUED'))::int AS "outOfStock",
            COUNT(*) FILTER (WHERE sp.stock_checked_at IS NULL OR sp.stock_checked_at < now() - interval '48 hours')::int AS stale
          FROM suppliers s JOIN supplier_products sp ON sp.supplier_id = s.id GROUP BY 1 ORDER BY "outOfStock" DESC`;
        break;
      case 'publication_success':
        rows = (await this.prisma.$queryRaw<any[]>`
          SELECT l.marketplace::text AS marketplace, COUNT(*)::int AS attempted, COUNT(*) FILTER (WHERE j.status = 'SUCCEEDED')::int AS succeeded, COUNT(*) FILTER (WHERE j.status = 'FAILED')::int AS failed
          FROM listing_publication_jobs j JOIN marketplace_listings l ON l.id = j.listing_id
          WHERE j.operation IN ('CREATE', 'REVISE') AND j.created_at >= ${f.from} AND j.created_at < ${f.to} GROUP BY 1`).map((r) => ({ ...r, rate: pct(r.succeeded, r.attempted) }));
        break;
      case 'awaiting_fulfilment':
        rows = (await this.prisma.order.findMany({ where: { status: { in: ['PAID', 'AWAITING_DISPATCH'] }, marketplace: f.marketplace as never }, orderBy: { dispatchBy: 'asc' }, include: { fulfilments: true }, take: 1000 })).map((o) => ({ order: `#${o.orderNumber} (${o.externalOrderId})`, marketplace: o.marketplace, date: o.orderedAt, dispatchBy: o.dispatchBy, fulfilment: o.fulfilments[0]?.status ?? 'PENDING' }));
        break;
      case 'returns_refund_rate':
        rows = (await this.prisma.$queryRaw<any[]>`
          SELECT o.marketplace::text AS marketplace, COUNT(DISTINCT o.id)::int AS orders, COUNT(DISTINCT r.order_id)::int AS "refundedOrders", COALESCE(SUM(r.amount), 0) AS refunded
          FROM orders o LEFT JOIN refunds r ON r.order_id = o.id
          WHERE o.ordered_at >= ${f.from} AND o.ordered_at < ${f.to} ${f.marketplace ? Prisma.sql`AND o.marketplace::text = ${f.marketplace}` : Prisma.empty} GROUP BY 1`).map((r) => ({ ...r, refunded: r2(r.refunded), rate: pct(r.refundedOrders, r.orders) }));
        break;
      case 'fees_actual_vs_estimated': {
        const lines = await this.prisma.orderLine.findMany({
          where: { order: { orderedAt: { gte: f.from, lt: f.to }, marketplace: f.marketplace as never, fees: { some: {} } } },
          include: { order: { include: { fees: true, lines: { select: { id: true } } } } },
          take: 5000,
        });
        const acc = new Map<string, { lines: number; est: Decimal; act: Decimal }>();
        const rules = new Map<string, Awaited<ReturnType<ProfitService['feeRules']>>>();
        for (const l of lines) {
          const mp = l.order.marketplace;
          if (!rules.has(mp)) rules.set(mp, await this.profit.feeRules(mp as MarketplaceCode));
          const est = estimateFees(rules.get(mp)!, { marketplace: mp, currency: l.order.currency, unitPrice: l.unitPrice.toString(), quantity: l.quantity, shippingCharged: l.shippingCharged.toString(), taxAmount: l.taxAmount?.toString() ?? 0, pricesIncludeTax: l.order.pricesIncludeTax, at: l.order.orderedAt }).reduce((a, x) => a.plus(x.amount), new Decimal(0));
          const act = l.order.fees.filter((x) => x.orderLineId === l.id || (!x.orderLineId && l.order.lines.length === 1)).reduce((a, x) => a.plus(x.amount.toString()), new Decimal(0));
          const cur = acc.get(mp) ?? { lines: 0, est: new Decimal(0), act: new Decimal(0) };
          acc.set(mp, { lines: cur.lines + 1, est: cur.est.plus(est), act: cur.act.plus(act) });
        }
        rows = [...acc.entries()].map(([marketplace, v]) => ({ marketplace, reconciledLines: v.lines, estimated: v.est.toFixed(2), actual: v.act.toFixed(2), variance: v.est.isZero() ? null : v.act.minus(v.est).div(v.est).times(100).toFixed(1) }));
        break;
      }
      case 'operating_expenses':
      case 'monthly_operating_profit': {
        const fx = await this.profit.fxTable();
        const expenses = await this.prisma.expense.findMany({ where: { date: { gte: f.from, lt: f.to }, attributedToOrders: false } });
        const conv = (e: (typeof expenses)[number]) => {
          try {
            return fx.convert(money(e.amount.toString(), e.currency), currency, e.date).converted.amount;
          } catch {
            return new Decimal(0);
          }
        };
        if (key === 'operating_expenses') {
          const by = new Map<string, { count: number; amount: Decimal }>();
          for (const e of expenses) {
            const c = by.get(e.category) ?? { count: 0, amount: new Decimal(0) };
            by.set(e.category, { count: c.count + 1, amount: c.amount.plus(conv(e)) });
          }
          rows = [...by.entries()].map(([category, v]) => ({ category, count: v.count, amount: v.amount.toFixed(2) })).sort((a, b) => n(b.amount) - n(a.amount));
        } else {
          const sales = await this.prisma.$queryRaw<any[]>`SELECT to_char(date_trunc('month', ordered_at), 'YYYY-MM') AS month, SUM(revenue) AS revenue, SUM(profit) AS profit FROM (${L}) l GROUP BY 1`;
          const months = new Map<string, { revenue: number; contribution: number; expenses: Decimal }>();
          for (const s of sales) months.set(s.month, { revenue: n(s.revenue), contribution: n(s.profit), expenses: new Decimal(0) });
          for (const e of expenses) {
            const m = e.date.toISOString().slice(0, 7);
            const cur = months.get(m) ?? { revenue: 0, contribution: 0, expenses: new Decimal(0) };
            months.set(m, { ...cur, expenses: cur.expenses.plus(conv(e)) });
          }
          rows = [...months.entries()].sort().map(([month, v]) => ({ month, revenue: v.revenue.toFixed(2), contribution: v.contribution.toFixed(2), expenses: v.expenses.toFixed(2), operatingProfit: (v.contribution - v.expenses.toNumber()).toFixed(2) }));
        }
        break;
      }
    }
    return { key, title: def.title, columns: def.columns, currency, period: { from: f.from, to: f.to }, marketplace: f.marketplace ?? null, dataStatus: await this.dataStatus(f), rows };
  }
}
