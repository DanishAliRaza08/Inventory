'use client';
import Link from 'next/link';
import { use, useState } from 'react';
import useSWR from 'swr';
import { Alert, Card, ErrorText, Field, Modal, PageHeader, StatusBadge } from '@/components/ui';
import { api, fetcher } from '@/lib/api';
import { MARKETPLACE_NAMES, ago, money } from '@/lib/format';
import { useCan } from '@/lib/session';

interface Variant {
  id: string; sku: string; size: string | null; colour: string | null; material: string | null; barcode: string | null;
  inventory: Array<{ available: number; reserved: number; committed: number; damaged: number; returned: number; safetyStock: number; policy: string }>;
  supplierProducts: Array<{ id: string; priority: number; currentPrice: string; shippingCost: string; currency: string; url: string | null; stockStatus: string; reportedQuantity: number | null; stockCheckedAt: string | null; stockSource: string | null; manuallyVerifiedAt: string | null; supplier: { id: string; name: string } }>;
  costRecords: Array<{ id: string; effectiveFrom: string; effectiveTo: string | null; currency: string; supplierPrice: string; supplierShipping: string; packaging: string; importDuty: string; otherPerUnit: string; source: string; verifiedAt: string | null }>;
}
interface Product {
  id: string; code: string; title: string; description: string; category: string | null; brand: string | null; status: string; fulfilmentModel: string; restricted: boolean;
  images: Array<{ id: string; url: string; width: number | null; height: number | null; isMain: boolean }>;
  variants: Variant[];
  listings: Array<{ id: string; marketplace: string; status: string; sku: string; price: string | null; currency: string; externalListingId: string | null; account: { name: string } }>;
}

function Availability({ variantId }: { variantId: string }) {
  const { data } = useSWR<{ model: string; availableToSell: number; stale: boolean; reasons: string[] }>(`/variants/${variantId}/inventory`, fetcher);
  if (!data) return <span className="text-muted">…</span>;
  return (
    <span title={data.reasons.join('\n')}>
      <strong>{data.availableToSell}</strong> to sell{data.stale && <span className="ml-1 text-xs" style={{ color: 'var(--critical)' }}>■ stale</span>}
      <span className="block text-xs text-muted">{data.reasons[0]}</span>
    </span>
  );
}

export default function ProductDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const can = useCan();
  const { data: p, mutate, error: loadError } = useSWR<Product>(`/products/${id}`, fetcher);
  const [costFor, setCostFor] = useState<Variant | null>(null);
  const [cost, setCost] = useState({ currency: 'USD', supplierPrice: '', supplierShipping: '0', packaging: '0', importDuty: '0', fxConversionPercent: '0', otherPerUnit: '0', notes: '', verified: true });
  const [stockFor, setStockFor] = useState<Variant | null>(null);
  const [stock, setStock] = useState({ stockStatus: 'IN_STOCK', reportedQuantity: '', source: 'manual-check', manuallyVerified: true, counted: '' });
  const [error, setError] = useState<unknown>(null);

  if (loadError) return <ErrorText error={loadError} />;
  if (!p) return <p className="text-sm text-ink2">Loading…</p>;

  const upload = async (file: File) => {
    try { await api.upload(`/products/${p.id}/images`, file); void mutate(); } catch (e) { setError(e); }
  };

  return (
    <div>
      <PageHeader
        title={p.title}
        subtitle={<>{p.code} · {p.category ?? 'Uncategorised'} · {p.fulfilmentModel === 'PHYSICAL' ? 'Physical stock' : 'Dropship'} {p.restricted && '· Restricted product'}</>}
        actions={<><StatusBadge status={p.status} />{can('listings.write') && <Link className="btn-primary" href={`/listings/new?variants=${p.variants.map((v) => v.id).join(',')}`}>Create listing drafts</Link>}</>}
      />
      <ErrorText error={error} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Images" className="lg:col-span-1" actions={can('listings.write') && <label className="btn cursor-pointer">Upload<input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} /></label>}>
          {p.images.length === 0 ? <Alert>No images yet. Every listing needs at least one image.</Alert> : (
            <div className="grid grid-cols-3 gap-2">
              {p.images.map((img) => (
                <figure key={img.id} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img.url} alt="" className="aspect-square w-full rounded border border-line object-cover" />
                  <figcaption className="text-xs text-muted">{img.isMain ? 'Main · ' : ''}{img.width}×{img.height}</figcaption>
                </figure>
              ))}
            </div>
          )}
        </Card>
        <Card title="Description" className="lg:col-span-2"><p className="whitespace-pre-wrap text-sm text-ink2">{p.description || 'No description.'}</p></Card>
      </div>

      <h2 className="mb-2 mt-6 text-sm font-semibold text-ink2">SKUs</h2>
      <div className="space-y-4">
        {p.variants.map((v) => {
          const inv = v.inventory[0];
          const open = v.costRecords.find((c) => !c.effectiveTo);
          return (
            <Card key={v.id} title={<>{v.sku} <span className="font-normal text-ink2">{[v.size && `Size ${v.size}`, v.colour, v.material].filter(Boolean).join(' · ')}</span></>}
              actions={<div className="flex gap-2">
                {can('costs.write') && <button className="btn" onClick={() => { setCostFor(v); setCost({ ...cost, currency: open?.currency ?? 'USD', supplierPrice: open?.supplierPrice ?? '', supplierShipping: open?.supplierShipping ?? '0', packaging: open?.packaging ?? '0' }); }}>Update cost</button>}
                {can('inventory.adjust') && <button className="btn" onClick={() => setStockFor(v)}>Stock check</button>}
              </div>}>
              <div className="grid gap-4 md:grid-cols-3">
                <div>
                  <h3 className="mb-1 text-xs font-semibold text-ink2">Availability</h3>
                  <Availability variantId={v.id} />
                  {p.fulfilmentModel === 'PHYSICAL' && inv && <p className="mt-1 text-xs text-muted">Available {inv.available} · reserved {inv.reserved} · committed {inv.committed} · damaged {inv.damaged} · returned {inv.returned} · safety {inv.safetyStock}</p>}
                </div>
                <div>
                  <h3 className="mb-1 text-xs font-semibold text-ink2">Suppliers</h3>
                  {v.supplierProducts.length === 0 && <p className="text-sm text-muted">None linked</p>}
                  {v.supplierProducts.map((sp) => (
                    <div key={sp.id} className="mb-1 text-sm">
                      <Link className="font-medium hover:underline" href={`/suppliers/${sp.supplier.id}`}>{sp.supplier.name}</Link> {sp.priority > 1 && <span className="text-xs text-muted">(backup {sp.priority - 1})</span>}
                      <div className="text-xs text-ink2">{money(sp.currentPrice, sp.currency)} + {money(sp.shippingCost, sp.currency)} shipping · <StatusBadge status={sp.stockStatus} /> {sp.reportedQuantity ?? ''}</div>
                      <div className="text-xs text-muted">Stock checked {ago(sp.stockCheckedAt)} via {sp.stockSource ?? '—'}{sp.manuallyVerifiedAt ? ` · verified ${ago(sp.manuallyVerifiedAt)}` : ' · not manually verified'}</div>
                      {sp.url && <a className="text-xs text-brand underline" href={sp.url} target="_blank" rel="noreferrer noopener">Supplier page</a>}
                    </div>
                  ))}
                </div>
                <div>
                  <h3 className="mb-1 text-xs font-semibold text-ink2">Cost history (effective-dated)</h3>
                  {v.costRecords.length === 0 && <Alert>No cost recorded; profit cannot be calculated.</Alert>}
                  <table className="w-full text-xs">
                    <tbody>
                      {v.costRecords.map((c) => (
                        <tr key={c.id}>
                          <td className="py-0.5">{new Date(c.effectiveFrom).toLocaleDateString('en-GB')}{c.effectiveTo ? '' : ' → now'}</td>
                          <td className="num">{money(c.supplierPrice, c.currency)} + {money(c.supplierShipping, c.currency)}</td>
                          <td className="pl-2">{c.verifiedAt ? '✓ verified' : <span style={{ color: 'var(--serious)' }}>▲ unverified</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      <h2 className="mb-2 mt-6 text-sm font-semibold text-ink2">Marketplace listings</h2>
      <Card>
        {p.listings.length === 0 ? <p className="text-sm text-ink2">Not listed on any marketplace.</p> : (
          <table className="w-full">
            <thead><tr><th className="th">Marketplace</th><th className="th">Account</th><th className="th">SKU</th><th className="th">Listing ID</th><th className="th">Status</th><th className="th num">Price</th></tr></thead>
            <tbody>{p.listings.map((l) => (
              <tr key={l.id}><td className="td"><Link className="hover:underline" href={`/listings/${l.id}`}>{MARKETPLACE_NAMES[l.marketplace]}</Link></td><td className="td text-xs">{l.account.name}</td><td className="td text-xs">{l.sku}</td><td className="td text-xs">{l.externalListingId ?? '—'}</td><td className="td"><StatusBadge status={l.status} /></td><td className="td num">{money(l.price, l.currency)}</td></tr>
            ))}</tbody>
          </table>
        )}
      </Card>

      <Modal open={!!costFor} title={`New cost for ${costFor?.sku}`} onClose={() => setCostFor(null)}
        footer={<><button className="btn" onClick={() => setCostFor(null)}>Cancel</button><button className="btn-primary" onClick={async () => {
          try { await api.post(`/variants/${costFor!.id}/costs`, cost); setCostFor(null); void mutate(); } catch (e) { setError(e); setCostFor(null); }
        }}>Save new cost</button></>}>
        <p className="mb-3 text-xs text-ink2">The current cost is closed and kept in history; orders already sold keep the cost that applied when they were sold.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Currency"><select className="input" value={cost.currency} onChange={(e) => setCost({ ...cost, currency: e.target.value })}><option>USD</option><option>GBP</option><option>CNY</option><option>EUR</option></select></Field>
          {(['supplierPrice', 'supplierShipping', 'packaging', 'importDuty', 'otherPerUnit'] as const).map((k) => (
            <Field key={k} label={k.replace(/([A-Z])/g, ' $1').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}><input className="input" inputMode="decimal" value={cost[k]} onChange={(e) => setCost({ ...cost, [k]: e.target.value })} /></Field>
          ))}
          <Field label="FX conversion cost %"><input className="input" inputMode="decimal" value={cost.fxConversionPercent} onChange={(e) => setCost({ ...cost, fxConversionPercent: e.target.value })} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={cost.verified} onChange={(e) => setCost({ ...cost, verified: e.target.checked })} /> I have verified this cost with the supplier</label>
        </div>
      </Modal>

      <Modal open={!!stockFor} title={`Stock check for ${stockFor?.sku}`} onClose={() => setStockFor(null)}
        footer={<><button className="btn" onClick={() => setStockFor(null)}>Cancel</button><button className="btn-primary" onClick={async () => {
          try {
            if (p.fulfilmentModel === 'PHYSICAL') await api.post(`/variants/${stockFor!.id}/inventory/count`, { counted: Number(stock.counted), reason: stock.source });
            else {
              const sp = stockFor!.supplierProducts[0];
              if (!sp) throw new Error('Link a supplier first.');
              await api.post(`/supplier-products/${sp.id}/stock`, { stockStatus: stock.stockStatus, reportedQuantity: stock.reportedQuantity === '' ? null : Number(stock.reportedQuantity), source: stock.source, manuallyVerified: stock.manuallyVerified });
            }
            setStockFor(null); void mutate();
          } catch (e) { setError(e); setStockFor(null); }
        }}>Record</button></>}>
        {p.fulfilmentModel === 'PHYSICAL' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Counted quantity on hand"><input className="input" inputMode="numeric" value={stock.counted} onChange={(e) => setStock({ ...stock, counted: e.target.value })} /></Field>
            <Field label="Reason"><input className="input" value={stock.source} onChange={(e) => setStock({ ...stock, source: e.target.value })} /></Field>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <p className="text-xs text-ink2 sm:col-span-2">Supplier stock is recorded with its source and time. It is not treated as stock we own.</p>
            <Field label="Supplier status"><select className="input" value={stock.stockStatus} onChange={(e) => setStock({ ...stock, stockStatus: e.target.value })}>{['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK', 'UNKNOWN', 'DISCONTINUED'].map((s) => <option key={s}>{s}</option>)}</select></Field>
            <Field label="Reported quantity (optional)"><input className="input" inputMode="numeric" value={stock.reportedQuantity} onChange={(e) => setStock({ ...stock, reportedQuantity: e.target.value })} /></Field>
            <Field label="Source"><input className="input" value={stock.source} onChange={(e) => setStock({ ...stock, source: e.target.value })} /></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={stock.manuallyVerified} onChange={(e) => setStock({ ...stock, manuallyVerified: e.target.checked })} /> Confirmed directly with the supplier</label>
          </div>
        )}
      </Modal>
    </div>
  );
}
