'use client';
import Link from 'next/link';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import useSWR from 'swr';
import { Card, Empty, PageHeader, Pager, StatusBadge } from '@/components/ui';
import { fetcher, qs } from '@/lib/api';
import { MARKETPLACE_NAMES, dateTime, money } from '@/lib/format';

const STATUSES = ['PAID', 'AWAITING_DISPATCH', 'DISPATCHED', 'DELIVERED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'];

interface Row {
  id: string; orderNumber: number; externalOrderId: string; marketplace: string; status: string; orderedAt: string; dispatchBy: string | null; currency: string; settled: boolean;
  account: { name: string };
  lines: Array<{ sku: string; quantity: number; unitPrice: string; profit: Array<{ netProfit: string; status: string }> }>;
  fulfilments: Array<{ status: string }>;
}

function sumProfit(o: Row) {
  const ps = o.lines.flatMap((l) => l.profit);
  if (!ps.length) return null;
  const total = ps.reduce((a, p) => a + Number(p.netProfit), 0);
  const status = ps.every((p) => p.status === 'confirmed') ? 'confirmed' : ps.some((p) => p.status !== 'estimated') ? 'partially_reconciled' : 'estimated';
  return { total, status };
}

function OrdersInner() {
  const params = useSearchParams();
  const [f, setF] = useState({ status: params.get('status') ?? '', marketplace: '', search: '', sku: '', dueWithinHours: params.get('due') ?? '', page: 1 });
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v, page: 1 }));
  const { data } = useSWR<{ items: Row[]; total: number }>(`/orders${qs({ ...f, pageSize: 50 })}`, fetcher, { keepPreviousData: true, refreshInterval: 30_000 });
  const overdue = (o: Row) => o.dispatchBy && ['PAID', 'AWAITING_DISPATCH'].includes(o.status) && new Date(o.dispatchBy).getTime() < Date.now();
  return (
    <div>
      <PageHeader title="Orders" subtitle="All marketplaces in one list. Dispatch is recorded only after the marketplace accepts the tracking." />
      <div className="mb-3 flex flex-wrap gap-1">
        <button className={!f.status && !f.dueWithinHours ? 'btn-primary' : 'btn'} onClick={() => setF((p) => ({ ...p, status: '', dueWithinHours: '', page: 1 }))}>All</button>
        <button className={f.dueWithinHours ? 'btn-primary' : 'btn'} onClick={() => setF((p) => ({ ...p, status: '', dueWithinHours: '24', page: 1 }))}>Dispatch due in 24 h</button>
        {STATUSES.map((s) => <button key={s} className={f.status === s ? 'btn-primary' : 'btn'} onClick={() => setF((p) => ({ ...p, status: s, dueWithinHours: '', page: 1 }))}>{s.replace(/_/g, ' ').toLowerCase()}</button>)}
      </div>
      <Card>
        <div className="mb-3 flex flex-wrap gap-2">
          <input className="input max-w-xs" placeholder="Order number or marketplace order ID" value={f.search} onChange={(e) => set('search', e.target.value)} aria-label="Search orders" />
          <input className="input max-w-[12rem]" placeholder="SKU" value={f.sku} onChange={(e) => set('sku', e.target.value)} aria-label="SKU" />
          <select className="input w-auto" value={f.marketplace} onChange={(e) => set('marketplace', e.target.value)} aria-label="Marketplace">
            <option value="">All marketplaces</option>{Object.entries(MARKETPLACE_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px]">
            <thead><tr>{['Order', 'Marketplace', 'Ordered', 'Items', 'Status', 'Dispatch by', 'Total', 'Profit'].map((h) => <th key={h} className={`th ${['Total', 'Profit'].includes(h) ? 'num' : ''}`}>{h}</th>)}</tr></thead>
            <tbody>
              {data?.items.map((o) => {
                const p = sumProfit(o);
                const total = o.lines.reduce((a, l) => a + Number(l.unitPrice) * l.quantity, 0);
                return (
                  <tr key={o.id}>
                    <td className="td"><Link className="font-medium hover:underline" href={`/orders/${o.id}`}>#{o.orderNumber}</Link><div className="text-xs text-muted">{o.externalOrderId}</div></td>
                    <td className="td text-sm">{MARKETPLACE_NAMES[o.marketplace]}<div className="text-xs text-muted">{o.account.name}</div></td>
                    <td className="td text-xs">{dateTime(o.orderedAt)}</td>
                    <td className="td text-xs">{o.lines.map((l) => `${l.quantity}× ${l.sku}`).join(', ')}</td>
                    <td className="td"><StatusBadge status={o.status} />{o.settled && <div className="mt-0.5 text-xs text-muted">Paid out</div>}</td>
                    <td className="td text-xs">{overdue(o) ? <span style={{ color: 'var(--critical)' }}>■ Overdue · {dateTime(o.dispatchBy)}</span> : dateTime(o.dispatchBy)}</td>
                    <td className="td num">{money(total, o.currency)}</td>
                    <td className="td num">{p ? <><div style={{ color: p.total < 0 ? 'var(--critical)' : undefined }}>{money(p.total, o.currency)}</div><div className="text-xs text-muted">{p.status.replace('_', ' ')}</div></> : <span className="text-xs text-muted">no cost</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {data && data.items.length === 0 && <Empty>No orders match. Orders arrive from connected marketplaces every few minutes.</Empty>}
        </div>
        {data && <Pager page={f.page} pageSize={50} total={data.total} onPage={(page) => setF({ ...f, page })} />}
      </Card>
    </div>
  );
}

export default function OrdersPage() {
  return <Suspense><OrdersInner /></Suspense>;
}
