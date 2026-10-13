'use client';
import { useState } from 'react';
import useSWR from 'swr';
import { Alert, Card, ErrorText, Field, PageHeader } from '@/components/ui';
import { api, fetcher } from '@/lib/api';
import { MARKETPLACE_CURRENCY, MARKETPLACE_NAMES, dateTime, money } from '@/lib/format';
import { useCan } from '@/lib/session';

interface FeeRule { id: string; name: string; marketplace: string; feeType: string; basis: string; currency: string; percent: string | null; fixed: string | null; categoryIds: string[]; overrideGroup: string | null; active: boolean; notes: string | null }
interface Rate { id: string; base: string; quote: string; rate: string; asOf: string; source: string }
interface Expense { id: string; date: string; category: string; description: string; amount: string; currency: string; attributedToOrders: boolean }

export default function FinancePage() {
  const can = useCan();
  const [tab, setTab] = useState<'fees' | 'fx' | 'expenses'>('fees');
  const { data: rules, mutate: mRules } = useSWR<FeeRule[]>('/fee-rules', fetcher);
  const { data: rates, mutate: mRates } = useSWR<Rate[]>('/fx-rates', fetcher);
  const { data: expenses, mutate: mExp } = useSWR<Expense[]>('/expenses', fetcher);
  const [error, setError] = useState<unknown>(null);
  const [rule, setRule] = useState({ name: '', marketplace: 'EBAY_UK', feeType: 'final_value', basis: 'order_total_incl_tax', percent: '', fixed: '', categoryIds: '', overrideGroup: '' });
  const [rate, setRate] = useState({ base: 'USD', quote: 'GBP', rate: '', source: 'manual' });
  const [exp, setExp] = useState({ date: new Date().toISOString().slice(0, 10), category: 'SOFTWARE', description: '', amount: '', currency: 'GBP', attributedToOrders: false });
  const go = async (fn: () => Promise<unknown>, after: () => void) => { setError(null); try { await fn(); after(); } catch (e) { setError(e); } };

  return (
    <div>
      <PageHeader title="Costs & expenses" subtitle="Fee rules drive estimates; actual marketplace fees replace them once reconciled." />
      <div className="mb-3 flex gap-1">
        {([['fees', 'Marketplace fee rules'], ['fx', 'Exchange rates'], ['expenses', 'Business expenses']] as const).map(([k, l]) => <button key={k} className={tab === k ? 'btn-primary' : 'btn'} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      <ErrorText error={error} />
      {tab === 'fees' && (
        <div className="space-y-4">
          <Alert tone="info">Enter the fee rates that apply to your own accounts and categories. No marketplace fee schedule is assumed. Rules in the same override group compete: a category-specific rule replaces the generic one.</Alert>
          <Card>
            <div className="overflow-x-auto"><table className="w-full min-w-[800px]">
              <thead><tr>{['Marketplace', 'Name', 'Type', 'Basis', 'Rate', 'Categories', 'Group', 'Active'].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
              <tbody>{rules?.map((r) => (
                <tr key={r.id}><td className="td text-sm">{MARKETPLACE_NAMES[r.marketplace]}</td><td className="td text-sm">{r.name}{r.notes && <div className="text-xs text-muted">{r.notes}</div>}</td><td className="td text-xs">{r.feeType}</td><td className="td text-xs">{r.basis}</td>
                  <td className="td text-sm">{r.percent ? `${Number(r.percent)}%` : ''}{r.fixed ? ` + ${money(r.fixed, r.currency)}` : ''}</td><td className="td text-xs">{r.categoryIds.join(', ') || 'All'}</td><td className="td text-xs">{r.overrideGroup ?? '—'}</td>
                  <td className="td">{can('fees.write') ? <input type="checkbox" checked={r.active} aria-label="Active" onChange={(e) => go(() => api.patch(`/fee-rules/${r.id}`, { active: e.target.checked }), () => void mRules())} /> : r.active ? 'Yes' : 'No'}</td></tr>
              ))}</tbody>
            </table></div>
          </Card>
          {can('fees.write') && (
            <Card title="Add fee rule">
              <div className="grid gap-2 sm:grid-cols-4">
                <Field label="Name"><input className="input" value={rule.name} onChange={(e) => setRule({ ...rule, name: e.target.value })} /></Field>
                <Field label="Marketplace"><select className="input" value={rule.marketplace} onChange={(e) => setRule({ ...rule, marketplace: e.target.value })}>{Object.entries(MARKETPLACE_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
                <Field label="Type"><select className="input" value={rule.feeType} onChange={(e) => setRule({ ...rule, feeType: e.target.value })}>{['final_value', 'per_order', 'payment', 'listing', 'promoted', 'advertising', 'fulfilment', 'regulatory', 'other'].map((t) => <option key={t}>{t}</option>)}</select></Field>
                <Field label="Basis"><select className="input" value={rule.basis} onChange={(e) => setRule({ ...rule, basis: e.target.value })}>{['item_price', 'item_price_plus_shipping', 'order_total_incl_tax', 'order_total_excl_tax', 'per_unit', 'per_order'].map((t) => <option key={t}>{t}</option>)}</select></Field>
                <Field label="Percent"><input className="input" value={rule.percent} onChange={(e) => setRule({ ...rule, percent: e.target.value })} /></Field>
                <Field label={`Fixed (${MARKETPLACE_CURRENCY[rule.marketplace]})`}><input className="input" value={rule.fixed} onChange={(e) => setRule({ ...rule, fixed: e.target.value })} /></Field>
                <Field label="Category IDs (comma separated)"><input className="input" value={rule.categoryIds} onChange={(e) => setRule({ ...rule, categoryIds: e.target.value })} /></Field>
                <Field label="Override group"><input className="input" value={rule.overrideGroup} onChange={(e) => setRule({ ...rule, overrideGroup: e.target.value })} /></Field>
              </div>
              <button className="btn-primary mt-3" disabled={!rule.name} onClick={() => go(() => api.post('/fee-rules', {
                name: rule.name, marketplace: rule.marketplace, feeType: rule.feeType, basis: rule.basis, currency: MARKETPLACE_CURRENCY[rule.marketplace],
                percent: rule.percent || undefined, fixed: rule.fixed || undefined, categoryIds: rule.categoryIds.split(',').map((s) => s.trim()).filter(Boolean), overrideGroup: rule.overrideGroup || undefined,
              }), () => { setRule({ ...rule, name: '', percent: '', fixed: '' }); void mRules(); })}>Add rule</button>
            </Card>
          )}
        </div>
      )}
      {tab === 'fx' && (
        <div className="space-y-4">
          <Alert tone="info">Each calculation records the rate, source and timestamp it used. Amounts are never converted without a stored rate.</Alert>
          {can('fx.write') && (
            <Card title="Add rate">
              <div className="flex flex-wrap items-end gap-2">
                <Field label="1 unit of"><select className="input" value={rate.base} onChange={(e) => setRate({ ...rate, base: e.target.value })}><option>USD</option><option>GBP</option><option>CNY</option><option>EUR</option></select></Field>
                <Field label="equals"><input className="input w-32" value={rate.rate} onChange={(e) => setRate({ ...rate, rate: e.target.value })} /></Field>
                <Field label="of"><select className="input" value={rate.quote} onChange={(e) => setRate({ ...rate, quote: e.target.value })}><option>GBP</option><option>USD</option><option>CNY</option><option>EUR</option></select></Field>
                <Field label="Source"><input className="input w-36" value={rate.source} onChange={(e) => setRate({ ...rate, source: e.target.value })} /></Field>
                <button className="btn-primary" disabled={!rate.rate} onClick={() => go(() => api.post('/fx-rates', rate), () => { setRate({ ...rate, rate: '' }); void mRates(); })}>Save rate</button>
              </div>
            </Card>
          )}
          <Card><table className="w-full"><thead><tr>{['Pair', 'Rate', 'As of', 'Source'].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
            <tbody>{rates?.map((r) => <tr key={r.id}><td className="td">{r.base} → {r.quote}</td><td className="td num">{Number(r.rate).toFixed(6)}</td><td className="td text-sm">{dateTime(r.asOf)}</td><td className="td text-sm">{r.source}</td></tr>)}</tbody></table>
            {rates?.length === 0 && <Alert>No exchange rates yet. USD supplier costs cannot be converted for GBP marketplaces until a rate is added.</Alert>}
          </Card>
        </div>
      )}
      {tab === 'expenses' && (
        <div className="space-y-4">
          {can('expenses.write') && (
            <Card title="Record expense">
              <div className="grid gap-2 sm:grid-cols-6">
                <Field label="Date"><input type="date" className="input" value={exp.date} onChange={(e) => setExp({ ...exp, date: e.target.value })} /></Field>
                <Field label="Category"><select className="input" value={exp.category} onChange={(e) => setExp({ ...exp, category: e.target.value })}>{['SOFTWARE', 'ADVERTISING', 'ACCOUNTANCY', 'STORAGE', 'PACKAGING', 'RETURNS_HANDLING', 'BANK_CHARGES', 'STAFF', 'OTHER'].map((c) => <option key={c}>{c}</option>)}</select></Field>
                <div className="sm:col-span-2"><Field label="Description"><input className="input" value={exp.description} onChange={(e) => setExp({ ...exp, description: e.target.value })} /></Field></div>
                <Field label="Amount"><input className="input" value={exp.amount} onChange={(e) => setExp({ ...exp, amount: e.target.value })} /></Field>
                <Field label="Currency"><select className="input" value={exp.currency} onChange={(e) => setExp({ ...exp, currency: e.target.value })}><option>GBP</option><option>USD</option><option>EUR</option></select></Field>
              </div>
              <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={exp.attributedToOrders} onChange={(e) => setExp({ ...exp, attributedToOrders: e.target.checked })} /> Already charged at order level (exclude from operating expenses to avoid double counting)</label>
              <button className="btn-primary mt-3" disabled={!exp.description || !exp.amount} onClick={() => go(() => api.post('/expenses', exp), () => { setExp({ ...exp, description: '', amount: '' }); void mExp(); })}>Save expense</button>
            </Card>
          )}
          <Card><table className="w-full"><thead><tr>{['Date', 'Category', 'Description', 'Amount', 'Counted in operating profit', ''].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
            <tbody>{expenses?.map((e) => <tr key={e.id}><td className="td text-sm">{e.date.slice(0, 10)}</td><td className="td text-xs">{e.category}</td><td className="td text-sm">{e.description}</td><td className="td num">{money(e.amount, e.currency)}</td><td className="td text-sm">{e.attributedToOrders ? 'No (order-level)' : 'Yes'}</td>
              <td className="td">{can('expenses.write') && <button className="btn" onClick={() => confirm('Delete expense?') && go(() => api.del(`/expenses/${e.id}`), () => void mExp())}>Delete</button>}</td></tr>)}</tbody></table>
          </Card>
        </div>
      )}
    </div>
  );
}
