'use client';
import Link from 'next/link';
import { useState } from 'react';
import useSWR from 'swr';
import { BarList, LineChart } from '@/components/charts';
import { Alert, Card, PageHeader, Stat } from '@/components/ui';
import { fetcher, qs } from '@/lib/api';
import { MARKETPLACE_NAMES, ago, money, pct } from '@/lib/format';
import { useCan } from '@/lib/session';

const PRESETS = [
  ['today', 'Today'], ['yesterday', 'Yesterday'], ['last7', 'Last 7 days'], ['last30', 'Last 30 days'],
  ['this_month', 'This month'], ['last_month', 'Last month'], ['this_year', 'This year'], ['custom', 'Custom'],
] as const;

interface Summary {
  reportingCurrency: string;
  catalogue: Record<string, number> & { listingStatusCounts: Record<string, number> };
  orders: { total: number; awaitingDispatch: number; lateShipmentRisk: number };
  financials: Record<string, string | null>;
  dataFreshness: { lastSuccessfulSync: string | null; stale: boolean };
  warnings: string[];
}

export default function Dashboard() {
  const can = useCan();
  const [preset, setPreset] = useState<string>('last30');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [marketplace, setMarketplace] = useState('');
  const [bucket, setBucket] = useState<'day' | 'week' | 'month'>('day');
  const ready = preset !== 'custom' || (from && to);
  const query = qs({ preset, from: preset === 'custom' ? from : undefined, to: preset === 'custom' ? to : undefined, marketplace });
  const { data, error } = useSWR<Summary>(ready ? `/dashboard/summary${query}` : null, fetcher);
  const { data: series } = useSWR<Array<{ period: string; marketplace: string; revenue: string; profit: string }>>(
    ready && can('finance.read') ? `/dashboard/timeseries${query}&bucket=${bucket}` : null,
    fetcher,
  );
  const cur = data?.reportingCurrency ?? 'GBP';
  const f = data?.financials ?? {};
  const fmt = (n: number) => money(n, cur);

  const periods = [...new Set((series ?? []).map((s) => s.period))].sort();
  const sumBy = (key: 'revenue' | 'profit') => periods.map((p) => (series ?? []).filter((s) => s.period === p).reduce((a, s) => a + Number(s[key]), 0));
  const label = (p: string) => new Date(p).toLocaleDateString('en-GB', bucket === 'month' ? { month: 'short', year: '2-digit' } : { day: 'numeric', month: 'short' });
  const byMarketplace = Object.keys(MARKETPLACE_NAMES).map((mp) => ({
    label: MARKETPLACE_NAMES[mp]!,
    value: (series ?? []).filter((s) => s.marketplace === mp).reduce((a, s) => a + Number(s.profit), 0),
    note: `Revenue ${money((series ?? []).filter((s) => s.marketplace === mp).reduce((a, s) => a + Number(s.revenue), 0), cur)}`,
  }));

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle={data && <>Last successful marketplace sync: <strong>{ago(data.dataFreshness.lastSuccessfulSync)}</strong> · amounts in {cur} at the stored exchange rates</>}
      />
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Date range">
          {PRESETS.map(([k, l]) => (
            <button key={k} className={preset === k ? 'btn-primary' : 'btn'} onClick={() => setPreset(k)} aria-pressed={preset === k}>{l}</button>
          ))}
        </div>
        {preset === 'custom' && (
          <>
            <input type="date" className="input w-auto" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
            <input type="date" className="input w-auto" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
          </>
        )}
        <select className="input w-auto" value={marketplace} onChange={(e) => setMarketplace(e.target.value)} aria-label="Marketplace">
          <option value="">All marketplaces</option>
          {Object.entries(MARKETPLACE_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>

      {error && <Alert tone="critical">{String(error)}</Alert>}
      <div className="mb-4 space-y-2">
        {data?.warnings.map((w) => <Alert key={w}>{w}</Alert>)}
      </div>

      {data && (
        <>
          <h2 className="mb-2 text-sm font-semibold text-ink2">Catalogue & listings</h2>
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Master products" value={data.catalogue.products?.toLocaleString()} />
            <Stat label="Active listings" value={data.catalogue.activeListings?.toLocaleString()} />
            <Stat label="Drafts awaiting approval" value={<Link href="/listings?status=AWAITING_APPROVAL">{data.catalogue.listingsAwaitingApproval}</Link>} />
            <Stat label="Listings with errors" value={<Link href="/listings?status=PUBLICATION_FAILED">{data.catalogue.listingsWithErrors}</Link>} tone={data.catalogue.listingsWithErrors ? 'critical' : undefined} />
            <Stat label="Products out of stock" value={data.catalogue.productsOutOfStock} tone={data.catalogue.productsOutOfStock ? 'warning' : undefined} />
            <Stat label="Low supplier stock" value={data.catalogue.productsLowSupplierStock} tone={data.catalogue.productsLowSupplierStock ? 'warning' : undefined} />
            <Stat label="Listings losing money" value={data.catalogue.listingsBelowMinimumProfitablePrice} note="priced below break-even" tone={data.catalogue.listingsBelowMinimumProfitablePrice ? 'critical' : undefined} />
            <Stat label="Total orders" value={data.orders.total} />
            <Stat label="Awaiting dispatch" value={data.orders.awaitingDispatch} />
            <Stat label="Late shipment risk" value={data.orders.lateShipmentRisk} note="dispatch due within 24h" tone={data.orders.lateShipmentRisk ? 'critical' : undefined} />
          </div>

          {can('finance.read') && (
            <>
              <h2 className="mb-2 text-sm font-semibold text-ink2">Financials</h2>
              <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                <Stat label="Gross sales" value={money(f.grossSales, cur)} note="incl. tax collected" />
                <Stat label="Product cost" value={money(f.productCost, cur)} />
                <Stat label="Marketplace fees" value={money(f.marketplaceFees, cur)} />
                <Stat label="Shipping costs" value={money(f.shippingCosts, cur)} />
                <Stat label="Refunds & returns" value={money(f.refundsAndReturns, cur)} />
                <Stat label="Other business expenses" value={money(f.operatingExpenses, cur)} />
                <Stat label="Net profit" value={money(f.netProfit, cur)} tone={Number(f.netProfit) < 0 ? 'critical' : undefined} />
                <Stat label="Net profit margin" value={pct(f.netProfitMarginPercent)} />
                <Stat label="Estimated profit" value={money(f.estimatedProfit, cur)} note="from configured fee rules" />
                <Stat label="Confirmed profit" value={money(f.confirmedProfit, cur)} note="reconciled with settlements" tone="good" />
              </div>

              <div className="grid gap-4 lg:grid-cols-3">
                <Card
                  className="lg:col-span-2"
                  title="Sales and profit"
                  actions={
                    <select className="input w-auto py-0.5 text-xs" value={bucket} onChange={(e) => setBucket(e.target.value as typeof bucket)} aria-label="Granularity">
                      <option value="day">Daily</option><option value="week">Weekly</option><option value="month">Monthly</option>
                    </select>
                  }
                >
                  {periods.length ? (
                    <LineChart title="Net revenue and net profit over time" labels={periods.map(label)} format={fmt}
                      series={[
                        { key: 'rev', label: 'Net revenue', color: 'var(--series-1)', values: sumBy('revenue') },
                        { key: 'profit', label: 'Net profit', color: 'var(--series-2)', values: sumBy('profit') },
                      ]} />
                  ) : (
                    <p className="py-10 text-center text-sm text-ink2">No orders in this period. Order data arrives from connected marketplaces every few minutes.</p>
                  )}
                </Card>
                <Card title="Net profit by marketplace">
                  <BarList title="Net profit by marketplace" rows={byMarketplace} format={fmt} />
                </Card>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
