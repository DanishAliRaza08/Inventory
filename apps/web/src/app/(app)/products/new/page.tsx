'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Card, ErrorText, Field, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';

interface V { sku: string; size: string; colour: string; material: string; barcode: string; currency: string; supplierPrice: string; supplierShipping: string; initialStock: string }
const blank: V = { sku: '', size: '', colour: '', material: '', barcode: '', currency: 'USD', supplierPrice: '', supplierShipping: '', initialStock: '' };

export default function NewProduct() {
  const router = useRouter();
  const [p, setP] = useState({ title: '', description: '', category: '', brand: '', fulfilmentModel: 'DROPSHIP', status: 'DRAFT', restricted: false });
  const [variants, setVariants] = useState<V[]>([{ ...blank }]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const setV = (i: number, k: keyof V, v: string) => setVariants((vs) => vs.map((x, j) => (j === i ? { ...x, [k]: v } : x)));

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const body = {
        ...p,
        category: p.category || undefined,
        brand: p.brand || undefined,
        variants: variants.map((v) => ({
          sku: v.sku, size: v.size || undefined, colour: v.colour || undefined, material: v.material || undefined, barcode: v.barcode || undefined,
          initialCost: v.supplierPrice ? { currency: v.currency, supplierPrice: v.supplierPrice, supplierShipping: v.supplierShipping || '0' } : undefined,
          initialStock: v.initialStock ? Number(v.initialStock) : undefined,
        })),
      };
      const r = await api.post<{ id: string }>('/products', body);
      router.push(`/products/${r.id}`);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  return (
    <div className="max-w-5xl">
      <PageHeader title="New product" subtitle="Only enter verified facts; listings are generated from these fields and never invent missing details." />
      <div className="space-y-4">
        <ErrorText error={error} />
        <Card title="Product">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Title"><input className="input" value={p.title} onChange={(e) => setP({ ...p, title: e.target.value })} /></Field>
            <Field label="Category"><input className="input" value={p.category} onChange={(e) => setP({ ...p, category: e.target.value })} /></Field>
            <Field label="Brand (only if authorised)"><input className="input" value={p.brand} onChange={(e) => setP({ ...p, brand: e.target.value })} /></Field>
            <Field label="Fulfilment model">
              <select className="input" value={p.fulfilmentModel} onChange={(e) => setP({ ...p, fulfilmentModel: e.target.value })}>
                <option value="DROPSHIP">Dropship (supplier-fulfilled)</option><option value="PHYSICAL">Physical stock held by us</option>
              </select>
            </Field>
            <Field label="Description"><textarea className="input min-h-24" value={p.description} onChange={(e) => setP({ ...p, description: e.target.value })} /></Field>
            <div className="space-y-2">
              <Field label="Status"><select className="input" value={p.status} onChange={(e) => setP({ ...p, status: e.target.value })}><option>DRAFT</option><option>ACTIVE</option></select></Field>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={p.restricted} onChange={(e) => setP({ ...p, restricted: e.target.checked })} /> Restricted / regulated product (listings need compliance sign-off)</label>
            </div>
          </div>
        </Card>
        <Card title="SKUs & variations" actions={<button className="btn" onClick={() => setVariants([...variants, { ...blank, currency: variants[0]?.currency ?? 'USD' }])}>Add variation</button>}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px]">
              <thead><tr>{['Master SKU', 'Size', 'Colour', 'Material', 'Barcode', 'Cost currency', 'Supplier price', 'Supplier shipping', p.fulfilmentModel === 'PHYSICAL' ? 'Opening stock' : '', ''].map((h, i) => <th key={i} className="th">{h}</th>)}</tr></thead>
              <tbody>
                {variants.map((v, i) => (
                  <tr key={i}>
                    {(['sku', 'size', 'colour', 'material', 'barcode'] as const).map((k) => <td key={k} className="td"><input className="input" aria-label={k} value={v[k]} onChange={(e) => setV(i, k, e.target.value)} /></td>)}
                    <td className="td"><select className="input" value={v.currency} onChange={(e) => setV(i, 'currency', e.target.value)}><option>USD</option><option>GBP</option><option>CNY</option><option>EUR</option></select></td>
                    <td className="td"><input className="input" inputMode="decimal" value={v.supplierPrice} onChange={(e) => setV(i, 'supplierPrice', e.target.value)} aria-label="Supplier price" /></td>
                    <td className="td"><input className="input" inputMode="decimal" value={v.supplierShipping} onChange={(e) => setV(i, 'supplierShipping', e.target.value)} aria-label="Supplier shipping" /></td>
                    <td className="td">{p.fulfilmentModel === 'PHYSICAL' && <input className="input" inputMode="numeric" value={v.initialStock} onChange={(e) => setV(i, 'initialStock', e.target.value)} aria-label="Opening stock" />}</td>
                    <td className="td">{variants.length > 1 && <button className="btn" onClick={() => setVariants(variants.filter((_, j) => j !== i))} aria-label="Remove">✕</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <div className="flex justify-end gap-2"><button className="btn-primary" disabled={busy || !p.title || variants.some((v) => !v.sku)} onClick={save}>{busy ? 'Saving…' : 'Create product'}</button></div>
      </div>
    </div>
  );
}
