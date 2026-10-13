'use client';
import Link from 'next/link';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import useSWR from 'swr';
import { Alert, Card, Empty, ErrorText, Modal, PageHeader, Pager, StatusBadge } from '@/components/ui';
import { api, fetcher, qs } from '@/lib/api';
import { MARKETPLACE_NAMES, ago, money } from '@/lib/format';
import { useCan } from '@/lib/session';

const STATUSES = ['INCOMPLETE', 'DRAFT', 'VALIDATION_FAILED', 'AWAITING_APPROVAL', 'APPROVED', 'PUBLISHING', 'ACTIVE', 'PUBLICATION_FAILED', 'PAUSED', 'ENDED', 'ARCHIVED'];

interface Row { id: string; sku: string; title: string; marketplace: string; status: string; price: string | null; currency: string; externalListingId: string | null; lastError: string | null; updatedAt: string; account: { name: string; environment: string }; product: { title: string }; validation: { valid: boolean; blockingCount: number } | null }
interface Preview { total: number; eligibleCount: number; confirmToken: string; byAccount: Array<{ account: string; marketplace: string; environment: string; count: number; currency: string; totalListedValue: string }>; items: Array<{ id: string; sku: string; title: string; price: string | null; currency: string; account: string; eligible: boolean; reason: string | null }> }

function ListingsInner() {
  const can = useCan();
  const params = useSearchParams();
  const [f, setF] = useState({ status: params.get('status') ?? '', marketplace: '', search: '', page: 1 });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const { data, mutate } = useSWR<{ items: Row[]; total: number; statusCounts: Record<string, number> }>(`/listings${qs({ ...f, pageSize: 50 })}`, fetcher, { keepPreviousData: true, refreshInterval: 15_000 });
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v, page: 1 }));

  const bulkApprove = async () => {
    try {
      const r = await api.post<{ approved: number; results: Array<{ ok: boolean; error?: string }> }>('/listings/bulk-approve', { listingIds: [...sel] });
      setMsg(`${r.approved} approved; ${r.results.filter((x) => !x.ok).length} could not be approved (see each listing for reasons).`);
      setSel(new Set()); void mutate();
    } catch (e) { setError(e); }
  };

  return (
    <div>
      <PageHeader title="Marketplace listings" subtitle="Drafts, approvals and live listings across eBay UK, eBay USA, Amazon UK and TikTok Shop UK"
        actions={<><a className="btn" href="/api/exports/listings?format=xlsx">Export</a>{can('listings.write') && <Link className="btn-primary" href="/listings/new">New listing</Link>}</>} />
      <div className="mb-3 flex flex-wrap gap-1">
        <button className={!f.status ? 'btn-primary' : 'btn'} onClick={() => set('status', '')}>All</button>
        {STATUSES.map((s) => (
          <button key={s} className={f.status === s ? 'btn-primary' : 'btn'} onClick={() => set('status', s)}>
            {s.replace(/_/g, ' ').toLowerCase()} <span className="text-xs opacity-70">{data?.statusCounts[s] ?? 0}</span>
          </button>
        ))}
      </div>
      {msg && <div className="mb-3"><Alert tone="info">{msg}</Alert></div>}
      <ErrorText error={error} />
      <Card>
        <div className="mb-3 flex flex-wrap gap-2">
          <input className="input max-w-xs" placeholder="SKU, title or marketplace listing ID" value={f.search} onChange={(e) => set('search', e.target.value)} aria-label="Search listings" />
          <select className="input w-auto" value={f.marketplace} onChange={(e) => set('marketplace', e.target.value)} aria-label="Marketplace">
            <option value="">All marketplaces</option>{Object.entries(MARKETPLACE_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          {sel.size > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-ink2">{sel.size} selected</span>
              {can('listings.approve') && <button className="btn" onClick={bulkApprove}>Approve selected</button>}
              {can('listings.publish') && <button className="btn-primary" onClick={async () => { try { setPreview(await api.post<Preview>('/listings/bulk-publish/preview', { listingIds: [...sel] })); } catch (e) { setError(e); } }}>Publish selected…</button>}
            </div>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px]">
            <thead><tr>
              <th className="th w-8"><input type="checkbox" aria-label="Select all" onChange={(e) => setSel(e.target.checked ? new Set(data?.items.map((i) => i.id)) : new Set())} /></th>
              <th className="th">Listing</th><th className="th">Marketplace / account</th><th className="th">Status</th><th className="th">Checks</th><th className="th num">Price</th><th className="th">Updated</th>
            </tr></thead>
            <tbody>
              {data?.items.map((l) => (
                <tr key={l.id} className="hover:bg-plane">
                  <td className="td"><input type="checkbox" checked={sel.has(l.id)} onChange={() => setSel((s) => { const n = new Set(s); n.has(l.id) ? n.delete(l.id) : n.add(l.id); return n; })} aria-label={`Select ${l.sku}`} /></td>
                  <td className="td"><Link className="font-medium hover:underline" href={`/listings/${l.id}`}>{l.title || l.product.title}</Link><div className="text-xs text-muted">{l.sku}{l.externalListingId ? ` · ${l.externalListingId}` : ''}</div>{l.lastError && <div className="text-xs" style={{ color: 'var(--critical)' }}>■ {l.lastError}</div>}</td>
                  <td className="td text-xs">{MARKETPLACE_NAMES[l.marketplace]}<div className="text-muted">{l.account.name}</div></td>
                  <td className="td"><StatusBadge status={l.status} /></td>
                  <td className="td text-xs">{l.validation ? (l.validation.blockingCount ? <span style={{ color: 'var(--serious)' }}>▲ {l.validation.blockingCount} blocking</span> : <span style={{ color: 'var(--good-text)' }}>✓ passes</span>) : '—'}</td>
                  <td className="td num">{money(l.price, l.currency)}</td>
                  <td className="td text-xs text-muted">{ago(l.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data?.items.length === 0 && <Empty>No listings here yet.</Empty>}
        </div>
        {data && <Pager page={f.page} pageSize={50} total={data.total} onPage={(page) => setF((p) => ({ ...p, page }))} />}
      </Card>

      <Modal open={!!preview} title="Confirm publication" onClose={() => setPreview(null)}
        footer={<><button className="btn" onClick={() => setPreview(null)}>Cancel</button>
          <button className="btn-primary" disabled={!preview?.eligibleCount} onClick={async () => {
            try {
              const r = await api.post<{ results: Array<{ ok: boolean }> }>('/listings/bulk-publish', { listingIds: [...sel], confirmToken: preview!.confirmToken });
              setMsg(`${r.results.filter((x) => x.ok).length} listing(s) queued for publication. Each becomes Active only after the marketplace confirms.`);
              setPreview(null); setSel(new Set()); void mutate();
            } catch (e) { setError(e); setPreview(null); }
          }}>Publish {preview?.eligibleCount} listing(s)</button></>}>
        {preview && (
          <div className="space-y-3 text-sm">
            <p><strong>{preview.eligibleCount}</strong> of {preview.total} selected listings will be published:</p>
            <table className="w-full"><thead><tr><th className="th">Account</th><th className="th">Environment</th><th className="th num">Listings</th><th className="th num">Total listed value</th></tr></thead>
              <tbody>{preview.byAccount.map((a) => <tr key={a.account}><td className="td">{a.account}</td><td className="td">{a.environment}</td><td className="td num">{a.count}</td><td className="td num">{money(a.totalListedValue, a.currency)}</td></tr>)}</tbody></table>
            <details><summary className="cursor-pointer text-ink2">Prices per listing</summary>
              <ul className="mt-1 text-xs">{preview.items.map((i) => <li key={i.id}>{i.eligible ? '✓' : '✕'} {i.sku} · {money(i.price, i.currency)} · {i.account}{i.reason ? ` — ${i.reason}` : ''}</li>)}</ul></details>
            {preview.items.some((i) => !i.eligible) && <Alert>{preview.items.filter((i) => !i.eligible).length} listing(s) will be skipped (reasons above).</Alert>}
          </div>
        )}
      </Modal>
    </div>
  );
}

export default function ListingsPage() {
  return <Suspense><ListingsInner /></Suspense>;
}
