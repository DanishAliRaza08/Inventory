import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Decimal, MARKETPLACE_CODES, MissingFxRateError, money, round2 } from '@fr/core';
import { ProfitService } from '../finance/profit.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';

export interface DashboardFilter {
  from: Date;
  to: Date;
  marketplace?: string;
  variantId?: string;
  supplierId?: string;
}

const STALE_SYNC_HOURS = 6;

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly profit: ProfitService,
  ) {}

  private lineFilter(f: DashboardFilter) {
    const parts: Prisma.Sql[] = [Prisma.sql`o.ordered_at >= ${f.from} AND o.ordered_at < ${f.to}`, Prisma.sql`pc.is_current = true`];
    if (f.marketplace) parts.push(Prisma.sql`o.marketplace = ${f.marketplace}::"Marketplace"`);
    if (f.variantId) parts.push(Prisma.sql`ol.variant_id = ${f.variantId}::uuid`);
    if (f.supplierId) parts.push(Prisma.sql`EXISTS (SELECT 1 FROM supplier_products sp WHERE sp.variant_id = ol.variant_id AND sp.supplier_id = ${f.supplierId}::uuid)`);
    return Prisma.join(parts, ' AND ');
  }

  async summary(f: DashboardFilter) {
    const reportingCurrency = await this.settings.get('finance.reporting_currency');
    // Every component is converted with the rate stored on the calculation (never re-guessed).
    const rate = Prisma.sql`COALESCE((pc.breakdown->'reporting'->>'rate')::numeric, 1)`;
    const col = (k: string) => Prisma.sql`SUM((pc.breakdown->>${k})::numeric * ${rate})`;
    const where = this.lineFilter(f);
    const [fin] = await this.prisma.$queryRaw<Array<Record<string, Decimal | number | null>>>`
      SELECT COUNT(DISTINCT o.id)::int AS orders,
        ${col('grossCharged')} AS "grossSales", ${col('netRevenue')} AS "netRevenue", ${col('totalProductCost')} AS "productCost",
        ${col('marketplaceFees')} AS "marketplaceFees", ${col('paymentFees')} AS "paymentFees", ${col('fulfilmentCosts')} AS "shippingCosts",
        ${col('advertisingCosts')} AS "advertisingCosts", ${col('otherExpenses')} AS "otherOrderExpenses", ${col('netRefundCost')} AS "refunds",
        ${col('netProfit')} AS "contributionProfit",
        SUM(CASE WHEN pc.status = 'confirmed' THEN (pc.breakdown->>'netProfit')::numeric * ${rate} ELSE 0 END) AS "confirmedProfit",
        SUM(CASE WHEN pc.status <> 'confirmed' THEN (pc.breakdown->>'netProfit')::numeric * ${rate} ELSE 0 END) AS "estimatedProfit",
        BOOL_OR(pc.reporting_currency IS NOT NULL AND pc.reporting_currency <> ${reportingCurrency}) AS "currencyMismatch"
      FROM profit_calculations pc JOIN order_lines ol ON ol.id = pc.order_line_id JOIN orders o ON o.id = ol.order_id
      WHERE ${where}`;

    // Operating expenses not already attributed to orders (prevents double counting).
    const expenses = await this.prisma.expense.findMany({
      where: { date: { gte: f.from, lt: f.to }, attributedToOrders: false, marketplace: f.marketplace ? (f.marketplace as never) : undefined },
    });
    const fx = await this.profit.fxTable();
    let operatingExpenses = new Decimal(0);
    const warnings: string[] = [];
    for (const e of expenses) {
      try {
        operatingExpenses = operatingExpenses.plus(fx.convert(money(e.amount.toString(), e.currency), reportingCurrency, e.date).converted.amount);
      } catch (err) {
        if (err instanceof MissingFxRateError) warnings.push(`Expense "${e.description}" in ${e.currency} excluded: no exchange rate to ${reportingCurrency}.`);
        else throw err;
      }
    }

    const num = (v: unknown) => new Decimal((v as Decimal | null)?.toString() ?? 0);
    const netRevenue = num(fin?.netRevenue);
    const contribution = num(fin?.contributionProfit);
    const operatingProfit = contribution.minus(operatingExpenses);

    const [products, activeListings, awaitingApproval, listingErrors, statusCounts, lossMaking, outOfStock, lowStock, awaitingDispatch, lateRisk, syncStates, accounts] = await Promise.all([
      this.prisma.product.count({ where: { status: { not: 'ARCHIVED' } } }),
      this.prisma.marketplaceListing.count({ where: { status: 'ACTIVE', marketplace: f.marketplace as never } }),
      this.prisma.marketplaceListing.count({ where: { status: 'AWAITING_APPROVAL', marketplace: f.marketplace as never } }),
      this.prisma.marketplaceListing.count({ where: { status: { in: ['VALIDATION_FAILED', 'PUBLICATION_FAILED'] }, marketplace: f.marketplace as never } }),
      this.prisma.marketplaceListing.groupBy({ by: ['status'], _count: true, where: { marketplace: f.marketplace as never } }),
      this.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n FROM marketplace_listings l
        JOIN LATERAL (SELECT issues FROM listing_validation_results r WHERE r.version_id = l.current_version_id ORDER BY ran_at DESC LIMIT 1) v ON true
        WHERE l.status <> 'ARCHIVED' AND v.issues @> '[{"code":"BELOW_MIN_PROFITABLE_PRICE"}]'`,
      this.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT COUNT(DISTINCT v.product_id)::int AS n FROM product_variants v JOIN products p ON p.id = v.product_id
        LEFT JOIN inventory_records i ON i.variant_id = v.id AND i.location = 'MAIN'
        LEFT JOIN supplier_products sp ON sp.variant_id = v.id AND sp.priority = 1
        WHERE p.status = 'ACTIVE' AND (
          (p.fulfilment_model = 'PHYSICAL' AND COALESCE(i.available, 0) <= COALESCE(i.safety_stock, 0)) OR
          (p.fulfilment_model = 'DROPSHIP' AND (sp.id IS NULL OR sp.stock_status IN ('OUT_OF_STOCK', 'DISCONTINUED'))))`,
      this.prisma.supplierProduct.count({ where: { stockStatus: 'LOW_STOCK', priority: 1 } }),
      this.prisma.order.count({ where: { status: { in: ['PAID', 'AWAITING_DISPATCH'] }, marketplace: f.marketplace as never } }),
      this.prisma.order.count({ where: { status: { in: ['PAID', 'AWAITING_DISPATCH'] }, dispatchBy: { lt: new Date(Date.now() + 24 * 3_600_000) }, marketplace: f.marketplace as never } }),
      this.prisma.syncState.findMany({ include: { account: { select: { name: true, marketplace: true, environment: true } } } }),
      this.prisma.marketplaceAccount.findMany({ select: { name: true, marketplace: true, status: true, environment: true } }),
    ]);

    const productionAccounts = accounts.filter((a) => a.environment !== 'DEMO');
    const lastSync = syncStates.reduce<Date | null>((acc, s) => (s.lastSuccessAt && (!acc || s.lastSuccessAt > acc) ? s.lastSuccessAt : acc), null);
    const staleSync = !lastSync || Date.now() - lastSync.getTime() > STALE_SYNC_HOURS * 3_600_000;
    if (!productionAccounts.some((a) => a.status === 'CONNECTED')) {
      warnings.push('No marketplace account is connected. Order, fee and settlement figures are incomplete until marketplace integrations are live.');
    } else if (staleSync) {
      warnings.push(`Marketplace data has not synced in the last ${STALE_SYNC_HOURS} hours; figures may be out of date.`);
    }
    if (fin?.currencyMismatch) warnings.push('Some calculations were reported in a different reporting currency; totals mix currencies until they are recalculated.');

    return {
      period: { from: f.from, to: f.to },
      reportingCurrency,
      catalogue: {
        products,
        activeListings,
        listingsAwaitingApproval: awaitingApproval,
        listingsWithErrors: listingErrors,
        listingStatusCounts: Object.fromEntries(statusCounts.map((s) => [s.status, s._count])),
        productsOutOfStock: outOfStock[0]?.n ?? 0,
        productsLowSupplierStock: lowStock,
        listingsBelowMinimumProfitablePrice: lossMaking[0]?.n ?? 0,
      },
      orders: { total: Number(fin?.orders ?? 0), awaitingDispatch, lateShipmentRisk: lateRisk },
      financials: {
        grossSales: round2(num(fin?.grossSales)),
        netRevenue: round2(netRevenue),
        productCost: round2(num(fin?.productCost)),
        marketplaceFees: round2(num(fin?.marketplaceFees).plus(num(fin?.paymentFees))),
        shippingCosts: round2(num(fin?.shippingCosts)),
        advertisingCosts: round2(num(fin?.advertisingCosts)),
        refundsAndReturns: round2(num(fin?.refunds)),
        orderLevelOtherExpenses: round2(num(fin?.otherOrderExpenses)),
        contributionProfit: round2(contribution),
        operatingExpenses: round2(operatingExpenses),
        netProfit: round2(operatingProfit),
        netProfitMarginPercent: netRevenue.isZero() ? null : round2(operatingProfit.div(netRevenue).times(100)),
        estimatedProfit: round2(num(fin?.estimatedProfit)),
        confirmedProfit: round2(num(fin?.confirmedProfit)),
      },
      dataFreshness: {
        lastSuccessfulSync: lastSync,
        stale: staleSync,
        accounts: accounts,
        syncStates: syncStates.map((s) => ({ account: s.account.name, resource: s.resource, lastSuccessAt: s.lastSuccessAt, lastError: s.lastError })),
      },
      warnings,
    };
  }

  async timeseries(f: DashboardFilter, bucket: 'day' | 'week' | 'month') {
    const rate = Prisma.sql`COALESCE((pc.breakdown->'reporting'->>'rate')::numeric, 1)`;
    return this.prisma.$queryRaw<Array<{ period: Date; marketplace: string; revenue: Decimal; profit: Decimal; orders: number }>>`
      SELECT date_trunc(${bucket}, o.ordered_at) AS period, o.marketplace::text AS marketplace,
        SUM((pc.breakdown->>'netRevenue')::numeric * ${rate}) AS revenue,
        SUM((pc.breakdown->>'netProfit')::numeric * ${rate}) AS profit,
        COUNT(DISTINCT o.id)::int AS orders
      FROM profit_calculations pc JOIN order_lines ol ON ol.id = pc.order_line_id JOIN orders o ON o.id = ol.order_id
      WHERE ${this.lineFilter(f)}
      GROUP BY 1, 2 ORDER BY 1, 2`;
  }

  marketplaces() {
    return MARKETPLACE_CODES;
  }
}
