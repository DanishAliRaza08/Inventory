'use client';
import Link from 'next/link';
import { useState } from 'react';
import useSWR from 'swr';
import { Card, Empty, ErrorText, PageHeader, StatusBadge } from '@/components/ui';
import { api, fetcher, qs } from '@/lib/api';
import { MARKETPLACE_NAMES, dateTime, money } from '@/lib/format';
import { useCan } from '@/lib/session';

interface OrderRef { id: string; orderNumber: number; externalOrderId: string; marketplace: string }
interface Ret { id: string; status: string; reason: string | null; restockable: boolean | null; returnShippingCost: string | null; currency: string | null; createdAt: string; receivedAt: string | null; order: OrderRef }
interface Refund { id: string; amount: string; currency: string; reason: string | null; refundedAt: string; source: string; order: OrderRef }

export default function ReturnsPage() {
  const can = useCan();
  const [status, setStatus] = useState('');
  const { data: returns, mutate } = useSWR<Ret[]>(`/returns${qs({ status })}`, fetcher);
  const { data: refunds } = useSWR<Refund[]>('/refunds', fetcher);
  const [error, setError] = useState<unknown>(null);
  const receive = async (id: string, restockable: boolean) => {
    setError(null);
    try { await api.post(`/returns/${id}/receive`, { restockable }); void mutate(); } catch (e) { setError(e); }
  };
  const orderLink = (o: OrderRef) => <Link className="hover:underline" href={`/orders/${o.id}`}>#{o.orderNumber}</Link>;
  return (
    <div>
      <PageHeader title="Returns & refunds" subtitle="Marketplace refunds import automatically with finance sync. Receiving a return restocks physical items or moves them to damaged stock." />
      <ErrorText error={error} />
      <Card title="Returns" actions={
        <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Return status">
          <option value="">All statuses</option>{['REQUESTED', 'APPROVED', 'IN_TRANSIT', 'RECEIVED', 'CLOSED', 'REJECTED'].map((s) => <option key={s} value={s}>{s.replace('_', ' ').toLowerCase()}</option>)}
        </select>}>
        <div className="overflow-x-auto"><table className="w-full min-w-[800px]">
          <thead><tr>{['Order', 'Marketplace', 'Opened', 'Reason', 'Status', 'Return postage', ''].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
          <tbody>{returns?.map((r) => (
            <tr key={r.id}>
              <td className="td text-sm">{orderLink(r.order)}<div className="text-xs text-muted">{r.order.externalOrderId}</div></td>
              <td className="td text-sm">{MARKETPLACE_NAMES[r.order.marketplace]}</td>
              <td className="td text-xs">{dateTime(r.createdAt)}</td>
              <td className="td text-sm">{r.reason ?? '—'}</td>
              <td className="td"><StatusBadge status={r.status} />{r.restockable != null && <div className="text-xs text-muted">{r.restockable ? 'Restocked' : 'Damaged'}</div>}</td>
              <td className="td text-sm">{r.returnShippingCost ? money(r.returnShippingCost, r.currency ?? 'GBP') : '—'}</td>
              <td className="td">{can('returns.manage') && !['RECEIVED', 'CLOSED', 'REJECTED'].includes(r.status) && <div className="flex gap-1">
                <button className="btn" onClick={() => receive(r.id, true)}>Received – restock</button>
                <button className="btn" onClick={() => receive(r.id, false)}>Received – damaged</button>
              </div>}</td>
            </tr>
          ))}</tbody>
        </table>{returns?.length === 0 && <Empty>No returns.</Empty>}</div>
      </Card>
      <Card title="Refunds" className="mt-4">
        <div className="overflow-x-auto"><table className="w-full min-w-[700px]">
          <thead><tr>{['Order', 'Marketplace', 'Refunded', 'Reason', 'Source', 'Amount'].map((h) => <th key={h} className={`th ${h === 'Amount' ? 'num' : ''}`}>{h}</th>)}</tr></thead>
          <tbody>{refunds?.map((r) => (
            <tr key={r.id}>
              <td className="td text-sm">{orderLink(r.order)}</td>
              <td className="td text-sm">{MARKETPLACE_NAMES[r.order.marketplace]}</td>
              <td className="td text-xs">{dateTime(r.refundedAt)}</td>
              <td className="td text-sm">{r.reason ?? '—'}</td>
              <td className="td text-xs">{r.source}</td>
              <td className="td num">{money(r.amount, r.currency)}</td>
            </tr>
          ))}</tbody>
        </table>{refunds?.length === 0 && <Empty>No refunds.</Empty>}</div>
      </Card>
    </div>
  );
}
