'use client';
import Link from 'next/link';
import useSWR from 'swr';
import { Alert, Card, PageHeader } from '@/components/ui';
import { fetcher } from '@/lib/api';

interface P { items: Array<{ id: string; code: string; title: string; fulfilmentModel: string; variants: Array<{ sku: string; supplierProducts: Array<{ stockStatus: string; supplier: { name: string } }> }> }>; total: number }
interface Unverified { id: string; effectiveFrom: string; verifiedAt: string | null; variant: { sku: string; productId: string; product: { title: string } } }

function List({ title, url, empty }: { title: string; url: string; empty: string }) {
  const { data } = useSWR<P>(url, fetcher);
  return (
    <Card title={`${title}${data ? ` (${data.total})` : ''}`}>
      {data?.items.length === 0 ? <p className="text-sm text-ink2">{empty}</p> : (
        <ul className="space-y-1 text-sm">{data?.items.map((p) => <li key={p.id}><Link className="hover:underline" href={`/products/${p.id}`}>{p.code} · {p.title}</Link> <span className="text-xs text-muted">{p.variants[0]?.supplierProducts[0]?.supplier.name ?? (p.fulfilmentModel === 'PHYSICAL' ? 'own stock' : 'no supplier')}</span></li>)}</ul>
      )}
    </Card>
  );
}

export default function StockPage() {
  const { data: unverified } = useSWR<Unverified[]>('/costs/unverified', fetcher);
  return (
    <div>
      <PageHeader title="Stock monitoring" subtitle="Owned stock and supplier availability, kept separate." />
      <div className="mb-4"><Alert tone="info">Automatic supplier stock polling and marketplace quantity sync arrive with the supplier and marketplace connectors (Phases 3–4). Until then, record stock checks on each product page; supplier data older than 48 hours is treated as unavailable.</Alert></div>
      <div className="grid gap-4 lg:grid-cols-2">
        <List title="Out of stock" url="/products?stock=out&pageSize=50" empty="Nothing out of stock." />
        <List title="Low supplier stock" url="/products?stock=low&pageSize=50" empty="No low-stock warnings." />
        <Card title={`Costs needing verification${unverified ? ` (${unverified.length})` : ''}`} className="lg:col-span-2">
          <ul className="max-h-80 space-y-1 overflow-auto text-sm">{unverified?.map((c) => <li key={c.id}><Link className="hover:underline" href={`/products/${c.variant.productId}`}>{c.variant.sku}</Link> · {c.variant.product.title} <span className="text-xs text-muted">{c.verifiedAt ? `verified ${new Date(c.verifiedAt).toLocaleDateString('en-GB')}` : 'never verified'}</span></li>)}</ul>
        </Card>
      </div>
    </div>
  );
}
