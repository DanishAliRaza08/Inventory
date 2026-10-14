'use client';
import Link from 'next/link';
import { useState } from 'react';
import useSWR from 'swr';
import { Alert, Card, Empty, ErrorText, PageHeader } from '@/components/ui';
import { api, fetcher } from '@/lib/api';
import { MARKETPLACE_NAMES, money, pct } from '@/lib/format';
import { useCan } from '@/lib/session';

interface Proposal { listingId: string; sku: string; marketplace: string; currency: string; currentPrice: string; currentProfit: string; currentMarginPercent: string | null; minimumProfitablePrice: string | null; proposedPrice: string | null; proposedProfit: string | null; reason: string }

export default function RepricingPage() {
  const can = useCan();
  const { data, mutate, isLoading } = useSWR<Proposal[]>('/listings/repricing/proposals', fetcher);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const canApply = can('listings.approve') && can('listings.publish');

  const apply = async (p: Proposal) => {
    const price = prices[p.listingId] ?? p.proposedPrice;
    if (!price) return;
    if (!confirm(`Change ${p.sku} on ${MARKETPLACE_NAMES[p.marketplace]} from ${money(p.currentPrice, p.currency)} to ${money(price, p.currency)}?`)) return;
    setError(null); setMsg(null);
    try {
      await api.post(`/listings/${p.listingId}/reprice`, { price, note: `Repricing: ${p.reason}` });
      setDone(new Set(done).add(p.listingId));
      setMsg(`${p.sku}: price change sent to the marketplace. It shows as applied once the marketplace confirms.`);
      void mutate();
    } catch (e) { setError(e); }
  };

  return (
    <div>
      <PageHeader title="Repricing proposals" subtitle="Live listings priced below their minimum profitable price or your target margin, using current costs, fee rules and FX. Nothing changes until you approve it." actions={<Link className="btn" href="/listings">All listings</Link>} />
      {msg && <div className="mb-3"><Alert tone="good">{msg}</Alert></div>}
      <ErrorText error={error} />
      <Card>
        <div className="overflow-x-auto"><table className="w-full min-w-[1000px]">
          <thead><tr>{['Listing', 'Reason', 'Current price', 'Profit / sale', 'Margin', 'Break-even', 'New price', ''].map((h, i) => <th key={h + i} className={`th ${i >= 2 && i <= 6 ? 'num' : ''}`}>{h}</th>)}</tr></thead>
          <tbody>{data?.map((p) => (
            <tr key={p.listingId}>
              <td className="td text-sm"><Link className="hover:underline" href={`/listings/${p.listingId}`}>{p.sku}</Link><div className="text-xs text-muted">{MARKETPLACE_NAMES[p.marketplace]}</div></td>
              <td className="td text-xs">{p.reason}</td>
              <td className="td num">{money(p.currentPrice, p.currency)}</td>
              <td className="td num" style={Number(p.currentProfit) < 0 ? { color: 'var(--critical)' } : undefined}>{money(p.currentProfit, p.currency)}</td>
              <td className="td num">{pct(p.currentMarginPercent)}</td>
              <td className="td num">{money(p.minimumProfitablePrice, p.currency)}</td>
              <td className="td num">
                {p.proposedPrice ? <input className="input w-24 text-right" value={prices[p.listingId] ?? p.proposedPrice} onChange={(e) => setPrices({ ...prices, [p.listingId]: e.target.value })} aria-label={`New price for ${p.sku}`} disabled={!canApply} />
                  : <span className="text-xs text-muted">target not reachable</span>}
                {p.proposedProfit && <div className="text-xs text-muted">profit {money(p.proposedProfit, p.currency)}</div>}
              </td>
              <td className="td">{canApply && p.proposedPrice && (done.has(p.listingId) ? <span className="text-xs text-ink2">Sent</span> : <button className="btn-primary" onClick={() => apply(p)}>Approve</button>)}</td>
            </tr>
          ))}</tbody>
        </table>
        {isLoading && <Empty>Calculating…</Empty>}
        {data?.length === 0 && <Empty>Every live listing meets your minimum margin.</Empty>}</div>
        <p className="mt-2 text-xs text-muted">Target margin comes from Settings → finance. Figures assume one unit, no shipping charged and no discount.</p>
      </Card>
    </div>
  );
}
