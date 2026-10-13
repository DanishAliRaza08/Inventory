'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import useSWR from 'swr';
import { Alert, Card, ErrorText, Field, PageHeader, StatusBadge } from '@/components/ui';
import { api, fetcher } from '@/lib/api';
import { MARKETPLACE_NAMES } from '@/lib/format';

interface Account { id: string; name: string; marketplace: string; environment: string; status: string }
interface Template { id: string; name: string; marketplace: string }

function NewListingInner() {
  const router = useRouter();
  const params = useSearchParams();
  const initial = (params.get('variants') ?? '').split(',').filter(Boolean);
  const [variantIds, setVariantIds] = useState<string[]>(initial);
  const [skuSearch, setSkuSearch] = useState('');
  const { data: accounts } = useSWR<Account[]>('/integrations/accounts', fetcher);
  const { data: templates } = useSWR<Template[]>('/listings/templates', fetcher);
  const { data: found } = useSWR<{ variants: Array<{ id: string; sku: string; product: { title: string } }> }>(skuSearch.length >= 2 ? `/search?q=${encodeURIComponent(skuSearch)}` : null, fetcher);
  const [accountId, setAccountId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [pricing, setPricing] = useState<{ kind: string; value: string }>({ kind: 'margin', value: '25' });
  const [result, setResult] = useState<{ created: number; failed: number; results: Array<{ variantId: string; ok: boolean; listingId?: string; price?: string | null; error?: string; blocking?: number }> } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const account = accounts?.find((a) => a.id === accountId);

  const create = async () => {
    setBusy(true); setError(null);
    try {
      const body = {
        variantIds, accountId, templateId: templateId || undefined,
        pricing: pricing.kind === 'none' ? { kind: 'none' } : pricing.kind === 'fixed' ? { kind: 'fixed', price: pricing.value } : pricing.kind === 'margin' ? { kind: 'margin', percent: pricing.value } : { kind: 'profit', amount: pricing.value },
      };
      const r = await api.post<typeof result>('/listings/bulk-drafts', body);
      if (r && r.created === 1 && variantIds.length === 1) router.push(`/listings/${r.results[0]!.listingId}`);
      else setResult(r);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  return (
    <div className="max-w-4xl">
      <PageHeader title="Listing builder" subtitle="Create marketplace-specific drafts from master products. Drafts are saved here and nothing is sent to a marketplace until approved and published." />
      <ErrorText error={error} />
      <div className="space-y-4">
        <Card title="1. Products">
          <p className="mb-2 text-sm">{variantIds.length} SKU(s) selected. {variantIds.length > 0 && <button className="text-brand underline" onClick={() => setVariantIds([])}>Clear</button>}</p>
          <input className="input" placeholder="Find a SKU or product to add…" value={skuSearch} onChange={(e) => setSkuSearch(e.target.value)} aria-label="Find SKU" />
          {found?.variants.map((v) => (
            <button key={v.id} className="mt-1 block w-full rounded px-2 py-1 text-left text-sm hover:bg-plane" onClick={() => { setVariantIds((ids) => [...new Set([...ids, v.id])]); setSkuSearch(''); }}>
              + {v.sku} · {v.product.title}
            </button>
          ))}
          <p className="mt-2 text-xs text-muted">Tip: select products in <Link className="underline" href="/products">Products</Link> and choose "Create listing drafts".</p>
        </Card>
        <Card title="2. Marketplace & account">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Account">
              <select className="input" value={accountId} onChange={(e) => { setAccountId(e.target.value); setTemplateId(''); }}>
                <option value="">Choose…</option>
                {accounts?.map((a) => <option key={a.id} value={a.id}>{a.name} — {a.status.toLowerCase().replace('_', ' ')}</option>)}
              </select>
            </Field>
            <Field label="Template" hint="Templates adapt titles and descriptions to each marketplace; only verified product facts are used.">
              <select className="input" value={templateId} onChange={(e) => setTemplateId(e.target.value)} disabled={!account}>
                <option value="">Built-in {account ? MARKETPLACE_NAMES[account.marketplace] : ''} template</option>
                {templates?.filter((t) => t.marketplace === account?.marketplace).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
          </div>
          {account && account.status !== 'CONNECTED' && <div className="mt-3"><Alert>{account.name} is not connected. You can prepare and approve drafts now; publishing becomes possible once the account is connected.</Alert></div>}
        </Card>
        <Card title="3. Pricing">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Price strategy">
              <select className="input" value={pricing.kind} onChange={(e) => setPricing({ ...pricing, kind: e.target.value })}>
                <option value="margin">Target net margin %</option><option value="profit">Target net profit per sale</option><option value="fixed">Fixed price</option><option value="none">Set later</option>
              </select>
            </Field>
            {pricing.kind !== 'none' && <Field label={pricing.kind === 'margin' ? 'Margin %' : 'Amount'}><input className="input" inputMode="decimal" value={pricing.value} onChange={(e) => setPricing({ ...pricing, value: e.target.value })} /></Field>}
          </div>
          <p className="mt-2 text-xs text-ink2">Target prices are solved with the configured cost, fee, tax and exchange-rate model and rounded up to .99.</p>
        </Card>
        <div className="flex justify-end"><button className="btn-primary" disabled={busy || !accountId || variantIds.length === 0} onClick={create}>{busy ? 'Creating…' : `Create ${variantIds.length} draft(s)`}</button></div>
        {result && (
          <Card title={`${result.created} draft(s) created, ${result.failed} failed`}>
            <ul className="space-y-1 text-sm">
              {result.results.map((r) => (
                <li key={r.variantId}>{r.ok ? <><Link className="underline" href={`/listings/${r.listingId}`}>Draft</Link> {r.price ? `at ${r.price}` : ''} {r.blocking ? <StatusBadge status="INCOMPLETE" /> : null}</> : <span style={{ color: 'var(--critical)' }}>■ {r.error}</span>}</li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}

export default function NewListing() {
  return <Suspense><NewListingInner /></Suspense>;
}
