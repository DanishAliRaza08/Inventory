'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import useSWR from 'swr';
import { Alert, Card, ErrorText, Field, PageHeader, StatusBadge } from '@/components/ui';
import { api, fetcher } from '@/lib/api';
import { MARKETPLACE_NAMES, dateTime, money, pct } from '@/lib/format';
import { useCan } from '@/lib/session';

interface Profit { status: string; netRevenue: string; totalCost: string; totalFees: string; netProfit: string; marginPercent: string | null; breakdown: { warnings?: string[]; feeLines?: Array<{ name: string; amount: string; source: string }>; taxCollected?: string; taxTreatmentReason?: string; netRefundCost?: string; fulfilmentCosts?: string } }
interface Order {
  id: string; orderNumber: number; externalOrderId: string; marketplace: string; status: string; orderedAt: string; dispatchBy: string | null; currency: string; settled: boolean; taxTreatment: string;
  account: { name: string };
  lines: Array<{ id: string; sku: string; title: string; quantity: number; unitPrice: string; shippingCharged: string; sellerDiscount: string; variant: { productId: string } | null; profit: Profit[] }>;
  statusHistory: Array<{ id: string; fromStatus: string | null; toStatus: string; source: string; createdAt: string }>;
  fulfilments: Array<{ id: string; status: string; checklist: Array<{ step: string; done: boolean }> | null; supplierOrderRef: string | null; confirmedAt: string | null; confirmedSource: string | null; shipments: Array<{ id: string; carrier: string | null; trackingNumber: string | null; shippedAt: string | null; deliveredAt: string | null; pushedToMarketplaceAt: string | null }> }>;
  refunds: Array<{ id: string; amount: string; currency: string; reason: string | null; refundedAt: string; source: string }>;
  returns: Array<{ id: string; status: string; reason: string | null; restockable: boolean | null; returnShippingCost: string | null; createdAt: string }>;
  fees: Array<{ id: string; name: string; amount: string; currency: string; postedAt: string }>;
  customer: { country: string | null; purgeAfter: string | null; purgedAt: string | null } | null;
  supplierOrders: Array<{ id: string; status: string; externalOrderId: string | null; trackingNumber: string | null; carrier: string | null; lastError: string | null; supplier: { name: string } }>;
}
interface Customer { name?: string; email?: string; phone?: string; line1?: string; line2?: string; city?: string; region?: string; postcode?: string; country?: string }

export default function OrderPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const { data: o, mutate } = useSWR<Order>(`/orders/${id}`, fetcher);
  const { data: suppliers } = useSWR<Array<{ id: string; name: string }>>(can('suppliers.read') ? '/suppliers' : null, fetcher);
  const [error, setError] = useState<unknown>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ship, setShip] = useState({ carrier: '', trackingNumber: '', labelCost: '' });
  const [refund, setRefund] = useState({ amount: '', orderLineId: '', reason: '' });
  const [ret, setRet] = useState({ orderLineId: '', reason: '', returnShippingCost: '' });
  const [manual, setManual] = useState({ supplierId: '', externalOrderId: '' });
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [buyerMsg, setBuyerMsg] = useState('');
  const [reply, setReply] = useState<{ source: string; suggestion: { reply: string; needsHumanAttention: boolean; reasons: string[] } } | null>(null);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setError(null); setMsg(null); setBusy(true);
    try { await fn(); if (done) setMsg(done); await mutate(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  if (!o) return <div className="text-sm text-ink2">Loading…</div>;
  const open = ['PAID', 'AWAITING_DISPATCH'].includes(o.status);
  const profits = o.lines.flatMap((l) => l.profit);
  const totalProfit = profits.reduce((a, p) => a + Number(p.netProfit), 0);
  const hasDropship = o.fulfilments.some((f) => f.checklist?.some((c) => c.step.toLowerCase().includes('supplier')));

  return (
    <div>
      <PageHeader title={`Order #${o.orderNumber}`} subtitle={<>{MARKETPLACE_NAMES[o.marketplace]} · {o.account.name} · {o.externalOrderId} · ordered {dateTime(o.orderedAt)}</>}
        actions={<><StatusBadge status={o.status} />{o.settled && <StatusBadge status="confirmed" />}<Link className="btn" href="/orders">All orders</Link></>} />
      {msg && <div className="mb-3"><Alert tone="good">{msg}</Alert></div>}
      <ErrorText error={error} />
      {o.dispatchBy && open && new Date(o.dispatchBy).getTime() < Date.now() && <div className="mb-3"><Alert tone="critical">Dispatch deadline passed ({dateTime(o.dispatchBy)}). Late dispatch affects seller performance.</Alert></div>}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Items and profit" actions={profits.length > 0 && <span className="text-sm">Net profit <strong style={{ color: totalProfit < 0 ? 'var(--critical)' : undefined }}>{money(totalProfit, o.currency)}</strong></span>}>
            <table className="w-full">
              <thead><tr>{['Item', 'Qty', 'Price', 'Revenue (ex. tax)', 'Cost', 'Fees', 'Profit', 'Margin'].map((h) => <th key={h} className={`th ${h === 'Item' ? '' : 'num'}`}>{h}</th>)}</tr></thead>
              <tbody>{o.lines.map((l) => {
                const p = l.profit[0];
                return (
                  <tr key={l.id}>
                    <td className="td text-sm">{l.variant ? <Link className="hover:underline" href={`/products/${l.variant.productId}`}>{l.title}</Link> : <span>{l.title} <span style={{ color: 'var(--serious)' }}>▲ unmatched SKU</span></span>}<div className="text-xs text-muted">{l.sku}{p && <> · <StatusBadge status={p.status} /></>}</div>
                      {p?.breakdown.warnings?.map((w) => <div key={w} className="mt-1 text-xs" style={{ color: 'var(--serious)' }}>▲ {w}</div>)}
                    </td>
                    <td className="td num">{l.quantity}</td>
                    <td className="td num">{money(l.unitPrice, o.currency)}</td>
                    <td className="td num">{p ? money(p.netRevenue, o.currency) : '—'}</td>
                    <td className="td num">{p ? money(p.totalCost, o.currency) : '—'}</td>
                    <td className="td num">{p ? money(p.totalFees, o.currency) : '—'}</td>
                    <td className="td num font-medium">{p ? money(p.netProfit, o.currency) : '—'}</td>
                    <td className="td num">{p ? pct(p.marginPercent) : '—'}</td>
                  </tr>
                );
              })}</tbody>
            </table>
            {profits[0]?.breakdown.taxTreatmentReason && <p className="mt-2 text-xs text-muted">Tax: {profits[0].breakdown.taxTreatmentReason} VAT is never counted as revenue.</p>}
          </Card>

          <Card title="Fulfilment">
            {o.fulfilments.length === 0 && <p className="text-sm text-ink2">No fulfilment yet.</p>}
            {o.fulfilments.map((f) => (
              <div key={f.id} className="mb-3">
                <div className="mb-1 flex items-center gap-2"><StatusBadge status={f.status} />{f.supplierOrderRef && <span className="text-xs text-ink2">Supplier order {f.supplierOrderRef}</span>}{f.confirmedAt && <span className="text-xs text-muted">Confirmed {dateTime(f.confirmedAt)} ({f.confirmedSource})</span>}</div>
                {f.checklist && <ul className="text-sm">{f.checklist.map((c) => <li key={c.step}><span aria-hidden>{c.done ? '☑' : '☐'}</span> {c.step}</li>)}</ul>}
                {f.shipments.map((s) => (
                  <div key={s.id} className="mt-2 rounded border border-line p-2 text-sm">
                    {s.carrier} · <span className="font-mono">{s.trackingNumber}</span> · shipped {dateTime(s.shippedAt)}
                    <div className="text-xs text-muted">{s.pushedToMarketplaceAt ? `Accepted by marketplace ${dateTime(s.pushedToMarketplaceAt)}` : 'Not yet accepted by the marketplace'}{s.deliveredAt ? ` · delivered ${dateTime(s.deliveredAt)}` : ''}</div>
                  </div>
                ))}
              </div>
            ))}
            {o.supplierOrders.length > 0 && (
              <div className="mt-2 text-sm">
                <div className="label">Supplier orders</div>
                {o.supplierOrders.map((s) => <div key={s.id}>{s.supplier.name}: <StatusBadge status={s.status} /> {s.externalOrderId} {s.trackingNumber && <>· tracking {s.carrier} {s.trackingNumber}</>} {s.lastError && <span style={{ color: 'var(--critical)' }}>{s.lastError}</span>}</div>)}
              </div>
            )}
            {open && can('orders.manage') && (
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div>
                  <div className="label">Add tracking</div>
                  <p className="mb-2 text-xs text-muted">The order is marked dispatched only once the marketplace accepts the tracking.</p>
                  <div className="space-y-2">
                    <input className="input" placeholder="Carrier (e.g. Royal Mail)" value={ship.carrier} onChange={(e) => setShip({ ...ship, carrier: e.target.value })} aria-label="Carrier" />
                    <input className="input" placeholder="Tracking number" value={ship.trackingNumber} onChange={(e) => setShip({ ...ship, trackingNumber: e.target.value })} aria-label="Tracking number" />
                    <input className="input" placeholder={`Postage cost (${o.currency}, optional)`} value={ship.labelCost} onChange={(e) => setShip({ ...ship, labelCost: e.target.value })} aria-label="Postage cost" />
                    <button className="btn-primary" disabled={busy || !ship.carrier || ship.trackingNumber.length < 3} onClick={() => act(() => api.post(`/orders/${o.id}/shipments`, { carrier: ship.carrier, trackingNumber: ship.trackingNumber, labelCost: ship.labelCost || undefined }), 'Tracking accepted by the marketplace; order dispatched.')}>Send tracking</button>
                  </div>
                </div>
                {hasDropship && (
                  <div>
                    <div className="label">Supplier order</div>
                    <p className="mb-2 text-xs text-muted">Places the order with the primary supplier using the customer&apos;s delivery address. Nothing is ordered without this confirmation.</p>
                    {can('orders.customer_pii') && <button className="btn-primary mb-3" disabled={busy} onClick={() => confirm('Place this order with the supplier now? This spends money.') && act(() => api.post(`/orders/${o.id}/supplier-order`), 'Supplier order placed.')}>Place supplier order…</button>}
                    <div className="space-y-2">
                      <select className="input" value={manual.supplierId} onChange={(e) => setManual({ ...manual, supplierId: e.target.value })} aria-label="Supplier"><option value="">Already ordered manually with…</option>{suppliers?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
                      <input className="input" placeholder="Supplier order reference" value={manual.externalOrderId} onChange={(e) => setManual({ ...manual, externalOrderId: e.target.value })} aria-label="Supplier order reference" />
                      <button className="btn" disabled={busy || !manual.supplierId || !manual.externalOrderId} onClick={() => act(() => api.post(`/orders/${o.id}/supplier-order/manual`, manual), 'Supplier order recorded.')}>Record supplier order</button>
                    </div>
                  </div>
                )}
              </div>
            )}
            {o.status === 'DISPATCHED' && can('orders.manage') && <button className="btn mt-3" disabled={busy} onClick={() => act(() => api.post(`/orders/${o.id}/delivered`, {}), 'Marked delivered.')}>Mark delivered</button>}
          </Card>

          <Card title="Refunds and returns">
            {o.refunds.length === 0 && o.returns.length === 0 && <p className="text-sm text-ink2">None.</p>}
            {o.refunds.map((r) => <div key={r.id} className="text-sm">Refund {money(r.amount, r.currency)} · {dateTime(r.refundedAt)} · {r.reason ?? 'no reason'} <span className="text-xs text-muted">({r.source})</span></div>)}
            {o.returns.map((r) => (
              <div key={r.id} className="mt-1 flex flex-wrap items-center gap-2 text-sm">Return <StatusBadge status={r.status} /> {r.reason} {r.restockable != null && <span className="text-xs text-muted">{r.restockable ? 'restocked' : 'not restockable'}</span>}
                {can('returns.manage') && !['RECEIVED', 'CLOSED'].includes(r.status) && <>
                  <button className="btn" disabled={busy} onClick={() => act(() => api.post(`/returns/${r.id}/receive`, { restockable: true }), 'Return received and restocked.')}>Received – restock</button>
                  <button className="btn" disabled={busy} onClick={() => act(() => api.post(`/returns/${r.id}/receive`, { restockable: false }), 'Return received as damaged.')}>Received – damaged</button>
                </>}
              </div>
            ))}
            {can('returns.manage') && o.status !== 'CANCELLED' && (
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <div className="label">Record a refund</div>
                  <p className="text-xs text-muted">Use for refunds made outside the marketplace sync; marketplace refunds import automatically.</p>
                  <input className="input" placeholder={`Amount (${o.currency})`} value={refund.amount} onChange={(e) => setRefund({ ...refund, amount: e.target.value })} aria-label="Refund amount" />
                  <select className="input" value={refund.orderLineId} onChange={(e) => setRefund({ ...refund, orderLineId: e.target.value })} aria-label="Refund item"><option value="">Whole order</option>{o.lines.map((l) => <option key={l.id} value={l.id}>{l.sku}</option>)}</select>
                  <input className="input" placeholder="Reason" value={refund.reason} onChange={(e) => setRefund({ ...refund, reason: e.target.value })} aria-label="Refund reason" />
                  <button className="btn" disabled={busy || !refund.amount} onClick={() => act(() => api.post(`/orders/${o.id}/refunds`, { amount: refund.amount, orderLineId: refund.orderLineId || undefined, reason: refund.reason || undefined }), 'Refund recorded; profit recalculated.')}>Record refund</button>
                </div>
                <div className="space-y-2">
                  <div className="label">Open a return</div>
                  <select className="input" value={ret.orderLineId} onChange={(e) => setRet({ ...ret, orderLineId: e.target.value })} aria-label="Return item"><option value="">Whole order</option>{o.lines.map((l) => <option key={l.id} value={l.id}>{l.sku}</option>)}</select>
                  <input className="input" placeholder="Reason" value={ret.reason} onChange={(e) => setRet({ ...ret, reason: e.target.value })} aria-label="Return reason" />
                  <input className="input" placeholder={`Return postage we pay (${o.currency}, optional)`} value={ret.returnShippingCost} onChange={(e) => setRet({ ...ret, returnShippingCost: e.target.value })} aria-label="Return postage" />
                  <button className="btn" disabled={busy} onClick={() => act(() => api.post(`/orders/${o.id}/returns`, { orderLineId: ret.orderLineId || undefined, reason: ret.reason || undefined, returnShippingCost: ret.returnShippingCost || undefined }), 'Return opened.')}>Open return</button>
                </div>
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Customer">
            {o.customer?.purgedAt ? <p className="text-sm text-ink2">Personal data deleted {dateTime(o.customer.purgedAt)} under the retention policy.</p>
              : !can('orders.customer_pii') ? <p className="text-sm text-ink2">Ship-to country: {o.customer?.country ?? '—'}. Your role cannot view customer names or addresses.</p>
              : customer ? (
                <div className="text-sm">
                  <div className="font-medium">{customer.name}</div>
                  <div>{customer.line1}</div>{customer.line2 && <div>{customer.line2}</div>}
                  <div>{customer.city}{customer.region ? `, ${customer.region}` : ''} {customer.postcode}</div><div>{customer.country}</div>
                  {customer.email && <div className="mt-1 text-xs text-ink2">{customer.email}</div>}
                  {customer.phone && <div className="text-xs text-ink2">{customer.phone}</div>}
                </div>
              ) : <button className="btn" onClick={() => act(async () => setCustomer(await api.get<Customer>(`/orders/${o.id}/customer`)))}>Show delivery details</button>}
            {o.customer?.purgeAfter && !o.customer.purgedAt && <p className="mt-2 text-xs text-muted">Viewing is logged. Deleted automatically after {dateTime(o.customer.purgeAfter)}.</p>}
          </Card>

          <Card title="Marketplace fees">
            {o.fees.length === 0 ? <p className="text-sm text-ink2">Not imported yet; profit uses your fee rules as an estimate.</p>
              : <table className="w-full text-sm"><tbody>{o.fees.map((f) => <tr key={f.id}><td className="py-0.5">{f.name}</td><td className="num py-0.5">{money(f.amount, f.currency)}</td></tr>)}</tbody></table>}
          </Card>

          {can('orders.manage') && (
            <Card title="Draft a reply to the buyer">
              <textarea className="input min-h-[80px]" placeholder="Paste the buyer's message" value={buyerMsg} onChange={(e) => setBuyerMsg(e.target.value)} aria-label="Buyer message" />
              <button className="btn mt-2" disabled={busy || !buyerMsg.trim()} onClick={() => act(async () => setReply(await api.post(`/ai/orders/${o.id}/reply`, { message: buyerMsg })))}>Draft reply with AI</button>
              {reply && (
                <div className="mt-3 space-y-2">
                  {reply.suggestion.needsHumanAttention && <Alert tone="warning">Needs a person: {reply.suggestion.reasons.join('; ')}</Alert>}
                  <textarea className="input min-h-[160px] text-sm" defaultValue={reply.suggestion.reply} aria-label="Draft reply" />
                  <p className="text-xs text-muted">{reply.source === 'demo' ? 'Demo draft (AI not configured).' : 'AI draft.'} Review it and send it from the marketplace&apos;s messaging page — nothing is sent automatically.</p>
                </div>
              )}
            </Card>
          )}

          <Card title="History">
            <ul className="space-y-1 text-xs">{o.statusHistory.map((h) => <li key={h.id}>{dateTime(h.createdAt)} · {h.fromStatus ? `${h.fromStatus.toLowerCase()} → ` : ''}{h.toStatus.toLowerCase()} <span className="text-muted">({h.source})</span></li>)}</ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
