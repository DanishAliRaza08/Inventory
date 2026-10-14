'use client';
import { useState } from 'react';
import useSWR from 'swr';
import { Alert, Card, Empty, ErrorText, PageHeader, StatusBadge } from '@/components/ui';
import { fetcher, qs } from '@/lib/api';
import { MARKETPLACE_NAMES, money, pct } from '@/lib/format';
import { useCan } from '@/lib/session';

interface Col { key: string; label: string; type?: 'money' | 'percent' | 'number' | 'text' | 'date' }
interface Report { key: string; title: string; columns: Col[]; currency: string; dataStatus: { label: string; counts: Record<string, number>; total: number }; rows: Array<Record<string, unknown>> }

const PRESETS = [['last7', 'Last 7 days'], ['last30', 'Last 30 days'], ['this_month', 'This month'], ['last_month', 'Last month'], ['this_year', 'This year'], ['custom', 'Custom…']] as const;
const EXPORTS = [['Products, costs, stock & prices', '/api/exports/products'], ['Marketplace listings & statuses', '/api/exports/listings'], ['Cost history (effective-dated)', '/api/exports/costs']];

function cell(v: unknown, c: Col, currency: string) {
  if (v === null || v === undefined || v === '') return '—';
  if (c.type === 'money') return money(v as string, currency);
  if (c.type === 'percent') return pct(v as string);
  if (c.type === 'number') return Number(v).toLocaleString('en-GB');
  if (c.type === 'date') return new Date(v as string).toLocaleDateString('en-GB');
  if (c.key === 'marketplace') return MARKETPLACE_NAMES[v as string] ?? String(v);
  return String(v);
}

export default function ReportsPage() {
  const can = useCan();
  const { data: list } = useSWR<Array<{ key: string; title: string }>>('/reports', fetcher);
  const [key, setKey] = useState('sales_by_marketplace');
  const [f, setF] = useState({ preset: 'last30', from: '', to: '', marketplace: '' });
  const query = qs({ preset: f.preset, from: f.preset === 'custom' ? f.from : undefined, to: f.preset === 'custom' ? f.to : undefined, marketplace: f.marketplace });
  const ready = f.preset !== 'custom' || (f.from && f.to);
  const { data, error, isLoading } = useSWR<Report>(ready ? `/reports/${key}${query}` : null, fetcher, { keepPreviousData: true });
  const numeric = (c: Col) => ['money', 'percent', 'number'].includes(c.type ?? '');

  return (
    <div>
      <PageHeader title="Analytics & reports" subtitle="Every figure says whether it is estimated, partially reconciled or confirmed by marketplace settlements." />
      <div className="grid gap-4 lg:grid-cols-4">
        <Card title="Reports" className="lg:col-span-1">
          <ul className="space-y-0.5">
            {list?.map((r) => (
              <li key={r.key}><button className={`w-full rounded px-2 py-1 text-left text-sm ${key === r.key ? 'bg-plane font-semibold' : 'hover:bg-plane'}`} onClick={() => setKey(r.key)}>{r.title}</button></li>
            ))}
          </ul>
          <div className="mt-4 border-t border-line pt-3">
            <div className="label">Data exports</div>
            <ul className="space-y-2">{EXPORTS.map(([l, u]) => <li key={u} className="text-sm"><div>{l}</div><div className="mt-1 flex gap-1"><a className="btn" href={`${u}?format=xlsx`}>XLSX</a><a className="btn" href={`${u}?format=csv`}>CSV</a></div></li>)}</ul>
          </div>
        </Card>
        <div className="lg:col-span-3">
          <Card title={data?.title ?? 'Report'} actions={data && can('exports.run') && <div className="flex gap-1"><a className="btn" href={`/api/reports/${key}/export${query}${query ? '&' : '?'}format=csv`}>CSV</a><a className="btn" href={`/api/reports/${key}/export${query}${query ? '&' : '?'}format=xlsx`}>XLSX</a></div>}>
            <div className="mb-3 flex flex-wrap items-end gap-2">
              <select className="input w-auto" value={f.preset} onChange={(e) => setF({ ...f, preset: e.target.value })} aria-label="Period">{PRESETS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              {f.preset === 'custom' && <>
                <input className="input w-auto" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} aria-label="From" />
                <input className="input w-auto" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} aria-label="To" />
              </>}
              <select className="input w-auto" value={f.marketplace} onChange={(e) => setF({ ...f, marketplace: e.target.value })} aria-label="Marketplace">
                <option value="">All marketplaces</option>{Object.entries(MARKETPLACE_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              {data && <span className="ml-auto flex items-center gap-2 text-xs text-ink2">Data status: <StatusBadge status={data.dataStatus.label === 'Confirmed (settled)' ? 'confirmed' : data.dataStatus.label === 'Estimated' ? 'estimated' : data.dataStatus.label === 'No order data' ? 'UNKNOWN' : 'partially_reconciled'} />
                {data.dataStatus.total > 0 && <span className="text-muted">{data.dataStatus.counts.confirmed ?? 0} confirmed · {data.dataStatus.counts.partially_reconciled ?? 0} partial · {data.dataStatus.counts.estimated ?? 0} estimated lines</span>}</span>}
            </div>
            <ErrorText error={error} />
            {data && data.dataStatus.label !== 'Confirmed (settled)' && data.dataStatus.total > 0 && <div className="mb-3"><Alert tone="info">Some figures use estimated fees from your fee rules until the marketplace&apos;s actual fees and payouts are imported.</Alert></div>}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px]">
                <thead><tr>{data?.columns.map((c) => <th key={c.key} className={`th ${numeric(c) ? 'num' : ''}`}>{c.label}</th>)}</tr></thead>
                <tbody>{data?.rows.map((r, i) => <tr key={i}>{data.columns.map((c) => <td key={c.key} className={`td text-sm ${numeric(c) ? 'num' : ''}`} style={c.type === 'money' && Number(r[c.key]) < 0 ? { color: 'var(--critical)' } : undefined}>{cell(r[c.key], c, data.currency)}</td>)}</tr>)}</tbody>
              </table>
              {data && data.rows.length === 0 && <Empty>No data for this period.</Empty>}
              {isLoading && !data && <Empty>Loading…</Empty>}
            </div>
            {data && <p className="mt-2 text-xs text-muted">Amounts in {data.currency} (reporting currency), converted at the rate stored with each calculation.</p>}
          </Card>
        </div>
      </div>
    </div>
  );
}
