'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { Card, Empty, ErrorText, Modal, PageHeader, Pager, StatusBadge } from '@/components/ui';
import { api, fetcher, qs } from '@/lib/api';
import { MARKETPLACE_NAMES, money } from '@/lib/format';
import { useCan } from '@/lib/session';

interface ProductRow {
  id: string;
  code: string;
  title: string;
  category: string | null;
  status: string;
  fulfilmentModel: string;
  variants: Array<{ id: string; sku: string; inventory: Array<{ available: number }>; supplierProducts: Array<{ stockStatus: string; supplier: { name: string } }>; costRecords: Array<{ supplierPrice: string; currency: string }> }>;
  listings: Array<{ marketplace: string; status: string }>;
}

const VIEW_KEY = 'fr.products.view';

export default function ProductsPage() {
  const can = useCan();
  const [f, setF] = useState({ search: '', status: '', fulfilmentModel: '', stock: '', marketplace: '', unlisted: '', page: 1 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [patch, setPatch] = useState<{ status?: string; category?: string }>({});
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY);
      if (v) setF({ ...JSON.parse(v), page: 1 });
    } catch {}
  }, []);
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v, page: 1 }));
  const { data, mutate } = useSWR<{ items: ProductRow[]; total: number; page: number; pageSize: number }>(`/products${qs({ ...f, pageSize: 50 })}`, fetcher, { keepPreviousData: true });
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <div>
      <PageHeader
        title="Products & inventory"
        subtitle="Master catalogue: one permanent product ID, with SKUs mapped to marketplace listings"
        actions={<>
          <a className="btn" href="/api/exports/products?format=xlsx">Export XLSX</a>
          {can('imports.run') && <Link className="btn" href="/imports">Import</Link>}
          {can('products.write') && <Link className="btn-primary" href="/products/new">New product</Link>}
        </>}
      />
      <Card>
        <div className="mb-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-7">
          <input className="input lg:col-span-2" placeholder="Title, SKU, barcode, supplier SKU, FRP-…" value={f.search} onChange={(e) => set('search', e.target.value)} aria-label="Search products" />
          <select className="input" value={f.status} onChange={(e) => set('status', e.target.value)} aria-label="Status">
            <option value="">All statuses (not archived)</option>
            {['DRAFT', 'ACTIVE', 'DISCONTINUED', 'ARCHIVED'].map((s) => <option key={s}>{s}</option>)}
          </select>
          <select className="input" value={f.fulfilmentModel} onChange={(e) => set('fulfilmentModel', e.target.value)} aria-label="Fulfilment">
            <option value="">Any fulfilment</option><option value="PHYSICAL">Physical stock</option><option value="DROPSHIP">Dropship</option>
          </select>
          <select className="input" value={f.stock} onChange={(e) => set('stock', e.target.value)} aria-label="Stock">
            <option value="">Any stock</option><option value="out">Out of stock</option><option value="low">Low supplier stock</option>
          </select>
          <select className="input" value={f.marketplace} onChange={(e) => set('marketplace', e.target.value)} aria-label="Listed on">
            <option value="">Listed anywhere</option>
            {Object.entries(MARKETPLACE_NAMES).map(([k, v]) => <option key={k} value={k}>Listed on {v}</option>)}
          </select>
          <select className="input" value={f.unlisted} onChange={(e) => set('unlisted', e.target.value)} aria-label="Not listed on">
            <option value="">—</option>
            {Object.entries(MARKETPLACE_NAMES).map(([k, v]) => <option key={k} value={k}>Not on {v}</option>)}
          </select>
        </div>
        <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
          <button className="btn" onClick={() => { try { localStorage.setItem(VIEW_KEY, JSON.stringify(f)); } catch {} }}>Save view</button>
          {selected.size > 0 && (
            <>
              <span className="text-ink2">{selected.size} selected</span>
              {can('products.write') && <button className="btn" onClick={() => setBulkOpen(true)}>Bulk edit</button>}
              {can('listings.write') && <Link className="btn" href={`/listings/new?variants=${data?.items.filter((p) => selected.has(p.id)).flatMap((p) => p.variants.map((v) => v.id)).join(',')}`}>Create listing drafts</Link>}
              <button className="btn" onClick={() => setSelected(new Set())}>Clear</button>
            </>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[800px]">
            <thead>
              <tr>
                <th className="th w-8"><input type="checkbox" aria-label="Select all on page" onChange={(e) => setSelected(e.target.checked ? new Set(data?.items.map((p) => p.id)) : new Set())} /></th>
                <th className="th">Product</th><th className="th">SKUs</th><th className="th">Status</th><th className="th">Fulfilment</th><th className="th">Supplier / stock</th><th className="th num">Cost</th><th className="th">Listings</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((p) => {
                const v0 = p.variants[0];
                const sp = v0?.supplierProducts[0];
                const owned = p.variants.reduce((a, v) => a + (v.inventory[0]?.available ?? 0), 0);
                return (
                  <tr key={p.id} className="hover:bg-plane">
                    <td className="td"><input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} aria-label={`Select ${p.title}`} /></td>
                    <td className="td"><Link className="font-medium hover:underline" href={`/products/${p.id}`}>{p.title}</Link><div className="text-xs text-muted">{p.code}{p.category ? ` · ${p.category}` : ''}</div></td>
                    <td className="td text-xs">{p.variants.slice(0, 3).map((v) => v.sku).join(', ')}{p.variants.length > 3 ? ` +${p.variants.length - 3}` : ''}</td>
                    <td className="td"><StatusBadge status={p.status} /></td>
                    <td className="td text-xs">{p.fulfilmentModel === 'PHYSICAL' ? `Physical · ${owned} on hand` : 'Dropship'}</td>
                    <td className="td text-xs">{sp ? <>{sp.supplier.name} <StatusBadge status={sp.stockStatus} /></> : <span className="text-muted">No supplier</span>}</td>
                    <td className="td num text-xs">{v0?.costRecords[0] ? money(v0.costRecords[0].supplierPrice, v0.costRecords[0].currency) : '—'}</td>
                    <td className="td text-xs">{p.listings.length ? p.listings.map((l, i) => <span key={i} className="mr-1 inline-block">{MARKETPLACE_NAMES[l.marketplace]}: <StatusBadge status={l.status} /></span>) : <span className="text-muted">Not listed</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {data && data.items.length === 0 && <Empty>No products match these filters.</Empty>}
        </div>
        {data && <Pager page={f.page} pageSize={50} total={data.total} onPage={(page) => setF((p) => ({ ...p, page }))} />}
      </Card>
      <Modal open={bulkOpen} title={`Bulk edit ${selected.size} products`} onClose={() => setBulkOpen(false)}
        footer={<>
          <button className="btn" onClick={() => setBulkOpen(false)}>Cancel</button>
          <button className="btn-primary" disabled={!Object.values(patch).some(Boolean)} onClick={async () => {
            try {
              const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v));
              await api.post('/products/bulk-update', { productIds: [...selected], patch: clean });
              setBulkOpen(false); setSelected(new Set()); setPatch({}); void mutate();
            } catch (e) { setError(e); }
          }}>Apply to {selected.size}</button>
        </>}>
        <div className="space-y-3">
          <ErrorText error={error} />
          <label className="block"><span className="label">Status</span>
            <select className="input" value={patch.status ?? ''} onChange={(e) => setPatch({ ...patch, status: e.target.value || undefined })}>
              <option value="">(unchanged)</option>{['DRAFT', 'ACTIVE', 'DISCONTINUED'].map((s) => <option key={s}>{s}</option>)}
            </select></label>
          <label className="block"><span className="label">Category</span><input className="input" value={patch.category ?? ''} onChange={(e) => setPatch({ ...patch, category: e.target.value || undefined })} /></label>
          <p className="text-xs text-ink2">Bulk edits are recorded in the audit log. Marketplace listings are not changed by master product edits.</p>
        </div>
      </Modal>
    </div>
  );
}
