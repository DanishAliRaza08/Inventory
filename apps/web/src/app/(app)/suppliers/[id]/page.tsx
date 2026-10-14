'use client';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import useSWR from 'swr';
import { Alert, Card, ErrorText, Modal, PageHeader, StatusBadge } from '@/components/ui';
import { api, fetcher } from '@/lib/api';
import { ago, dateTime, money } from '@/lib/format';
import { useCan } from '@/lib/session';

interface SP { id: string; supplierSku: string | null; supplierProductId: string | null; url: string | null; currentPrice: string; shippingCost: string; currency: string; stockStatus: string; reportedQuantity: number | null; stockCheckedAt: string | null; stockSource: string | null; priority: number; variant: { sku: string; productId: string; product: { title: string } } }
interface Supplier { id: string; name: string; type: string; website: string | null; email: string | null; defaultCurrency: string; shipsFromCountry: string | null; processingDays: number | null; deliveryDaysMin: number | null; deliveryDaysMax: number | null; reliabilityNotes: string | null; products: SP[]; connection: { status: string; expiresAt: string | null; lastSyncAt: string | null; lastError: string | null } | null }

function SupplierInner() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const can = useCan();
  const { data: s, mutate } = useSWR<Supplier>(`/suppliers/${id}`, fetcher);
  const [error, setError] = useState<unknown>(null);
  const [msg, setMsg] = useState<string | null>(params.get('connected') ? 'Supplier connected.' : null);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<{ sp: SP; kind: 'price' | 'stock' } | null>(null);
  const [form, setForm] = useState({ currentPrice: '', shippingCost: '', stockStatus: 'IN_STOCK', reportedQuantity: '', source: 'manual check', manuallyVerified: true });

  const act = async (fn: () => Promise<unknown>, done: (r: any) => string) => {
    setBusy(true); setError(null); setMsg(null);
    try { const r = await fn(); setMsg(done(r)); void mutate(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  if (!s) return <div className="text-sm text-ink2">Loading…</div>;
  const api_ = s.type === 'ALIEXPRESS' || s.type === 'CJ_DROPSHIPPING';
  const connected = s.connection?.status === 'CONNECTED';

  return (
    <div>
      <PageHeader title={s.name} subtitle={<>{s.type.replace('_', ' ')} · {s.defaultCurrency} · ships from {s.shipsFromCountry ?? 'not set'}{s.processingDays != null ? ` · ${s.processingDays}d processing` : ''}{s.deliveryDaysMin != null ? ` · ${s.deliveryDaysMin}–${s.deliveryDaysMax}d delivery` : ''}</>}
        actions={<Link className="btn" href="/suppliers">All suppliers</Link>} />
      {msg && <div className="mb-3"><Alert tone="good">{msg}</Alert></div>}
      <ErrorText error={error} />
      {!s.shipsFromCountry && <div className="mb-3"><Alert tone="warning">Set the ships-from country: it decides whether the UK low-value import VAT rule applies to this supplier&apos;s items.</Alert></div>}

      {api_ && (
        <Card title="API connection" className="mb-4">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <StatusBadge status={s.connection?.status ?? 'NOT_CONNECTED'} />
            {s.connection?.lastSyncAt && <span className="text-ink2">Last sync {ago(s.connection.lastSyncAt)}</span>}
            {s.connection?.expiresAt && <span className="text-xs text-muted">Token expires {dateTime(s.connection.expiresAt)}</span>}
            {s.connection?.lastError && <span style={{ color: 'var(--critical)' }}>■ {s.connection.lastError}</span>}
            {can('suppliers.write') && (
              <span className="ml-auto flex gap-1">
                <button className={connected ? 'btn' : 'btn-primary'} disabled={busy} onClick={() => act(async () => {
                  const r = await api.get<{ url?: string; connected?: boolean }>(`/integrations/suppliers/${s.id}/connect`);
                  if (r.url) window.location.href = r.url;
                  return r;
                }, () => 'Supplier connected.')}>{connected ? 'Reconnect' : 'Connect'}</button>
                {connected && <button className="btn" disabled={busy} onClick={() => act(() => api.post('/integrations/suppliers/sync'), (r) => `Price and stock sync finished: ${JSON.stringify(r)}`)}>Sync prices & stock now</button>}
              </span>
            )}
          </div>
          <p className="mt-2 text-xs text-muted">{s.type === 'ALIEXPRESS' ? 'AliExpress Open Platform dropshipping API (OAuth).' : 'CJ Dropshipping API v2 using the server-side API key.'} Price rises create a new effective-dated cost record; orders are only placed after staff confirm them on the order page.</p>
        </Card>
      )}

      <Card title={`Supplied SKUs (${s.products.length})`}>
        <div className="overflow-x-auto"><table className="w-full min-w-[900px]">
          <thead><tr>{['SKU', 'Supplier ref', 'Price', 'Shipping', 'Stock', 'Checked', ''].map((h) => <th key={h} className={`th ${['Price', 'Shipping'].includes(h) ? 'num' : ''}`}>{h}</th>)}</tr></thead>
          <tbody>{s.products.map((p) => {
            const stale = !p.stockCheckedAt || Date.now() - new Date(p.stockCheckedAt).getTime() > 48 * 3_600_000;
            return (
              <tr key={p.id}>
                <td className="td text-sm"><Link className="hover:underline" href={`/products/${p.variant.productId}`}>{p.variant.sku}</Link><div className="text-xs text-muted">{p.variant.product.title}{p.priority > 1 ? ` · backup #${p.priority}` : ''}</div></td>
                <td className="td text-xs">{p.url ? <a className="underline" href={p.url} target="_blank" rel="noreferrer">{p.supplierProductId ?? 'link'}</a> : p.supplierProductId ?? '—'}{p.supplierSku && <div className="text-muted">{p.supplierSku}</div>}</td>
                <td className="td num">{money(p.currentPrice, p.currency)}</td>
                <td className="td num">{money(p.shippingCost, p.currency)}</td>
                <td className="td"><StatusBadge status={p.stockStatus} />{p.reportedQuantity != null && <div className="text-xs text-muted">{p.reportedQuantity} reported</div>}</td>
                <td className="td text-xs">{stale ? <span style={{ color: 'var(--serious)' }}>▲ {ago(p.stockCheckedAt)}</span> : ago(p.stockCheckedAt)}{p.stockSource && <div className="text-muted">{p.stockSource}</div>}</td>
                <td className="td"><div className="flex gap-1">
                  {api_ && connected && can('suppliers.write') && <button className="btn" disabled={busy} onClick={() => act(() => api.post(`/integrations/supplier-products/${p.id}/sync`), () => `${p.variant.sku} refreshed from the supplier.`)}>Refresh</button>}
                  {can('costs.write') && <button className="btn" onClick={() => { setEdit({ sp: p, kind: 'price' }); setForm({ ...form, currentPrice: p.currentPrice, shippingCost: p.shippingCost }); }}>Price…</button>}
                  {can('inventory.adjust') && <button className="btn" onClick={() => { setEdit({ sp: p, kind: 'stock' }); setForm({ ...form, stockStatus: p.stockStatus, reportedQuantity: p.reportedQuantity?.toString() ?? '' }); }}>Stock…</button>}
                </div></td>
              </tr>
            );
          })}</tbody>
        </table></div>
      </Card>

      <Modal open={!!edit} title={edit ? `${edit.kind === 'price' ? 'Record supplier price' : 'Record supplier stock'} · ${edit.sp.variant.sku}` : ''} onClose={() => setEdit(null)}
        footer={<><button className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn-primary" disabled={busy} onClick={() => act(async () => {
          if (edit!.kind === 'price') await api.post(`/supplier-products/${edit!.sp.id}/price`, { currentPrice: form.currentPrice, shippingCost: form.shippingCost || undefined, source: form.source });
          else await api.post(`/supplier-products/${edit!.sp.id}/stock`, { stockStatus: form.stockStatus, reportedQuantity: form.reportedQuantity ? Number(form.reportedQuantity) : null, source: form.source, manuallyVerified: form.manuallyVerified });
          setEdit(null);
        }, () => 'Saved.')}>Save</button></>}>
        {edit && (
          <div className="space-y-3">
            {edit.kind === 'price' ? <>
              <label className="block"><span className="label">Item price ({edit.sp.currency})</span><input className="input" value={form.currentPrice} onChange={(e) => setForm({ ...form, currentPrice: e.target.value })} /></label>
              <label className="block"><span className="label">Shipping to customer ({edit.sp.currency})</span><input className="input" value={form.shippingCost} onChange={(e) => setForm({ ...form, shippingCost: e.target.value })} /></label>
              <p className="text-xs text-muted">For the primary supplier this starts a new cost record from now; past orders keep the cost in effect when they sold.</p>
            </> : <>
              <label className="block"><span className="label">Stock status</span><select className="input" value={form.stockStatus} onChange={(e) => setForm({ ...form, stockStatus: e.target.value })}>{['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK', 'DISCONTINUED', 'UNKNOWN'].map((x) => <option key={x} value={x}>{x.replace('_', ' ').toLowerCase()}</option>)}</select></label>
              <label className="block"><span className="label">Quantity reported (optional)</span><input className="input" value={form.reportedQuantity} onChange={(e) => setForm({ ...form, reportedQuantity: e.target.value })} /></label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.manuallyVerified} onChange={(e) => setForm({ ...form, manuallyVerified: e.target.checked })} /> I confirmed this with the supplier</label>
            </>}
            <label className="block"><span className="label">Source</span><input className="input" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} /></label>
          </div>
        )}
      </Modal>
    </div>
  );
}

export default function SupplierPage() {
  return <Suspense><SupplierInner /></Suspense>;
}
