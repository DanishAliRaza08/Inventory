'use client';
import Link from 'next/link';
import { useState } from 'react';
import useSWR from 'swr';
import { Card, ErrorText, Field, PageHeader } from '@/components/ui';
import { api, fetcher } from '@/lib/api';
import { useCan } from '@/lib/session';

interface Supplier { id: string; name: string; type: string; website: string | null; defaultCurrency: string; processingDays: number | null; deliveryDaysMin: number | null; deliveryDaysMax: number | null; active: boolean; _count: { products: number } }

export default function SuppliersPage() {
  const can = useCan();
  const { data, mutate } = useSWR<Supplier[]>('/suppliers', fetcher);
  const [s, setS] = useState({ name: '', type: 'MANUAL', website: '', defaultCurrency: 'USD', email: '', processingDays: '', reliabilityNotes: '' });
  const [error, setError] = useState<unknown>(null);
  return (
    <div>
      <PageHeader title="Suppliers" subtitle="AliExpress, CJ Dropshipping and manually managed suppliers. Supplier stock is recorded with its source and time and never treated as our own stock." />
      <ErrorText error={error} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <table className="w-full"><thead><tr>{['Supplier', 'Type', 'Currency', 'Lead time', 'SKUs', 'Status'].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
            <tbody>{data?.map((x) => (
              <tr key={x.id}><td className="td"><Link className="font-medium hover:underline" href={`/suppliers/${x.id}`}>{x.name}</Link>{x.website && <div className="text-xs text-muted">{x.website}</div>}</td><td className="td text-xs">{x.type.replace('_', ' ')}</td><td className="td text-sm">{x.defaultCurrency}</td>
                <td className="td text-xs">{x.processingDays != null ? `${x.processingDays}d processing` : '—'}{x.deliveryDaysMin != null ? ` · ${x.deliveryDaysMin}–${x.deliveryDaysMax}d delivery` : ''}</td><td className="td num">{x._count.products}</td><td className="td text-sm">{x.active ? 'Active' : 'Inactive'}</td></tr>
            ))}</tbody></table>
        </Card>
        {can('suppliers.write') && (
          <Card title="Add supplier">
            <div className="space-y-2">
              <Field label="Name"><input className="input" value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} /></Field>
              <Field label="Type"><select className="input" value={s.type} onChange={(e) => setS({ ...s, type: e.target.value })}><option value="ALIEXPRESS">AliExpress</option><option value="CJ_DROPSHIPPING">CJ Dropshipping</option><option value="MANUAL">Manual</option><option value="OTHER">Other</option></select></Field>
              <Field label="Website"><input className="input" value={s.website} onChange={(e) => setS({ ...s, website: e.target.value })} /></Field>
              <Field label="Contact email"><input className="input" value={s.email} onChange={(e) => setS({ ...s, email: e.target.value })} /></Field>
              <Field label="Default currency"><select className="input" value={s.defaultCurrency} onChange={(e) => setS({ ...s, defaultCurrency: e.target.value })}><option>USD</option><option>GBP</option><option>CNY</option><option>EUR</option></select></Field>
              <Field label="Processing days"><input className="input" value={s.processingDays} onChange={(e) => setS({ ...s, processingDays: e.target.value })} /></Field>
              <Field label="Reliability notes"><textarea className="input" value={s.reliabilityNotes} onChange={(e) => setS({ ...s, reliabilityNotes: e.target.value })} /></Field>
              <button className="btn-primary" disabled={!s.name} onClick={async () => {
                setError(null);
                try {
                  await api.post('/suppliers', { name: s.name, type: s.type, website: s.website || undefined, email: s.email || undefined, defaultCurrency: s.defaultCurrency, processingDays: s.processingDays ? Number(s.processingDays) : undefined, reliabilityNotes: s.reliabilityNotes || undefined });
                  setS({ ...s, name: '', website: '', email: '', reliabilityNotes: '' }); void mutate();
                } catch (e) { setError(e); }
              }}>Add supplier</button>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
