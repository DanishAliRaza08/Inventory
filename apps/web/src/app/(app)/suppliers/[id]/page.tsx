'use client';
import Link from 'next/link';
import { use } from 'react';
import useSWR from 'swr';
import { Card, PageHeader, StatusBadge } from '@/components/ui';
import { fetcher } from '@/lib/api';
import { ago, money } from '@/lib/format';

interface Detail {
  id: string; name: string; type: string; website: string | null; email: string | null; phone: string | null; contactName: string | null; reliabilityNotes: string | null; notes: string | null; defaultCurrency: string; shipsFromCountry: string | null;
  products: Array<{ id: string; supplierSku: string | null; url: string | null; currentPrice: string; shippingCost: string; currency: string; stockStatus: string; reportedQuantity: number | null; stockCheckedAt: string | null; lastPriceUpdateAt: string; priority: number; variant: { sku: string; productId: string; product: { title: string } } }>;
}

export default function SupplierDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: s } = useSWR<Detail>(`/suppliers/${id}`, fetcher);
  if (!s) return <p className="text-sm text-ink2">Loading…</p>;
  return (
    <div>
      <PageHeader title={s.name} subtitle={<>{s.type.replace('_', ' ')} · {s.defaultCurrency} · ships from {s.shipsFromCountry ?? 'not set'}{s.website && <> · <a className="underline" href={s.website} target="_blank" rel="noreferrer noopener">{s.website}</a></>}</>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Contact & reliability">
          <dl className="space-y-1 text-sm"><dt className="text-ink2">Contact</dt><dd>{s.contactName ?? '—'} {s.email} {s.phone}</dd><dt className="text-ink2">Reliability notes</dt><dd className="whitespace-pre-wrap">{s.reliabilityNotes ?? '—'}</dd><dt className="text-ink2">Notes</dt><dd>{s.notes ?? '—'}</dd></dl>
        </Card>
        <Card title={`Supplied SKUs (${s.products.length})`} className="lg:col-span-2">
          <div className="overflow-x-auto"><table className="w-full min-w-[640px]"><thead><tr>{['SKU', 'Price + shipping', 'Stock', 'Checked', 'Price updated', 'Role'].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
            <tbody>{s.products.map((p) => (
              <tr key={p.id}><td className="td"><Link className="hover:underline" href={`/products/${p.variant.productId}`}>{p.variant.sku}</Link><div className="text-xs text-muted">{p.variant.product.title}</div></td>
                <td className="td text-sm">{money(p.currentPrice, p.currency)} + {money(p.shippingCost, p.currency)}</td><td className="td"><StatusBadge status={p.stockStatus} /> {p.reportedQuantity ?? ''}</td>
                <td className="td text-xs">{ago(p.stockCheckedAt)}</td><td className="td text-xs">{ago(p.lastPriceUpdateAt)}</td><td className="td text-xs">{p.priority === 1 ? 'Primary' : `Backup ${p.priority - 1}`}</td></tr>
            ))}</tbody></table></div>
        </Card>
      </div>
    </div>
  );
}
