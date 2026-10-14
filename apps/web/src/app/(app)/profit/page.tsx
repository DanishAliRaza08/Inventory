'use client';
import { useState } from 'react';
import useSWR from 'swr';
import { Alert, Card, ErrorText, Field, PageHeader, StatusBadge } from '@/components/ui';
import { api, fetcher } from '@/lib/api';
import { MARKETPLACE_CURRENCY, MARKETPLACE_NAMES, money, pct } from '@/lib/format';

type B = Record<string, string | null> & { status: string; currency: string; warnings: string[]; feeLines: Array<{ name: string; amount: string; explanation: string; source: string }>; fxConversions: Array<{ from: string; to: string; rate: string; asOf: string; source: string }>; reporting?: { currency: string; netProfit: string; rate: string } };
interface CalcResult { breakdown: B; alerts: Array<{ code: string; severity: string; message: string }>; minimumProfitablePrice: string | null; assumptions: { tax: { taxTreatment: string; taxTreatmentReason: string; taxRatePercent: string; pricesIncludeTax: boolean } } }

const ROWS: Array<[string, string, boolean?]> = [
  ['sellingPrice', 'Selling price'], ['customerShipping', 'Customer shipping revenue'], ['discounts', 'Discounts (seller-funded)', true], ['taxCollected', 'Tax collected (not revenue)', true],
  ['netRevenue', 'Net revenue excl. tax'], ['productCost', 'Product cost', true], ['supplierShipping', 'Supplier shipping', true], ['otherProductCosts', 'Packaging, duty, FX & other unit costs', true],
  ['marketplaceFees', 'Marketplace fees', true], ['paymentFees', 'Payment fees', true], ['fulfilmentCosts', 'Shipping & fulfilment', true], ['advertisingCosts', 'Advertising', true],
  ['otherExpenses', 'Other expenses', true], ['netRefundCost', 'Net refund / return cost', true],
];

export default function ProfitPage() {
  const [mode, setMode] = useState<'sku' | 'manual'>('sku');
  const [skuQ, setSkuQ] = useState('');
  const [variant, setVariant] = useState<{ id: string; sku: string } | null>(null);
  const { data: found } = useSWR<{ variants: Array<{ id: string; sku: string; product: { title: string } }> }>(mode === 'sku' && skuQ.length >= 2 && !variant ? `/search?q=${encodeURIComponent(skuQ)}` : null, fetcher);
  const [f, setF] = useState({ marketplace: 'EBAY_UK', unitPrice: '24.99', quantity: '1', shippingCharged: '0', sellerDiscount: '0', fulfilmentCost: '0', advertisingCost: '0', otherExpenses: '0', categoryId: '' });
  const [cost, setCost] = useState({ currency: 'USD', supplierPrice: '6.50', supplierShipping: '2.10', packaging: '0.25' });
  const [shipsFrom, setShipsFrom] = useState('CN');
  const [target, setTarget] = useState({ kind: 'margin', value: '25' });
  const [res, setRes] = useState<CalcResult | null>(null);
  const [rev, setRev] = useState<{ achievable: boolean; unitPrice: string | null; message: string; breakdown: B | null } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [demo, setDemo] = useState({ netSalesRevenue: '25', productCost: '8', supplierShipping: '2', marketplaceFees: '3', otherExpenses: '1' });
  const [demoRes, setDemoRes] = useState<{ netProfit: string; netMarginPercent: string | null } | null>(null);
  const cur = MARKETPLACE_CURRENCY[f.marketplace]!;

  const base = () => ({
    marketplace: f.marketplace, quantity: Number(f.quantity), shippingCharged: f.shippingCharged, sellerDiscount: f.sellerDiscount, fulfilmentCost: f.fulfilmentCost,
    advertisingCost: f.advertisingCost, otherExpenses: f.otherExpenses, categoryId: f.categoryId || undefined,
    ...(mode === 'sku' ? { variantId: variant?.id } : { cost, shipsFromCountry: shipsFrom || null }),
  });
  const calc = async () => { setError(null); try { setRes(await api.post<CalcResult>('/profit/calculate', { ...base(), unitPrice: f.unitPrice })); } catch (e) { setError(e); } };
  const reverse = async () => {
    setError(null);
    try { setRev(await api.post('/profit/reverse-price', { ...base(), target: target.kind === 'margin' ? { kind: 'margin', percent: target.value } : { kind: 'profit', amount: target.value }, ending: '.99' })); } catch (e) { setError(e); }
  };
  const b = res?.breakdown;

  return (
    <div>
      <PageHeader title="Profit & loss calculator" subtitle="Uses the configured costs, fee rules, tax treatment and stored exchange rates. Figures are estimates until actual fees are reconciled." />
      <ErrorText error={error} />
      <div className="mt-3 grid gap-4 lg:grid-cols-3">
        <Card title="Inputs" className="lg:col-span-1">
          <div className="space-y-3">
            <div className="flex gap-1" role="group" aria-label="Cost source">
              <button className={mode === 'sku' ? 'btn-primary' : 'btn'} onClick={() => setMode('sku')}>Existing SKU</button>
              <button className={mode === 'manual' ? 'btn-primary' : 'btn'} onClick={() => setMode('manual')}>Manual costs</button>
            </div>
            {mode === 'sku' ? (
              variant ? <p className="text-sm">SKU <strong>{variant.sku}</strong> <button className="text-brand underline" onClick={() => setVariant(null)}>change</button></p> : (
                <div>
                  <input className="input" placeholder="Find SKU…" value={skuQ} onChange={(e) => setSkuQ(e.target.value)} aria-label="Find SKU" />
                  {found?.variants.map((v) => <button key={v.id} className="block w-full px-2 py-1 text-left text-sm hover:bg-plane" onClick={() => setVariant(v)}>{v.sku} · {v.product.title}</button>)}
                </div>
              )
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <Field label="Cost currency"><select className="input" value={cost.currency} onChange={(e) => setCost({ ...cost, currency: e.target.value })}><option>USD</option><option>GBP</option><option>CNY</option></select></Field>
                <Field label="Supplier price"><input className="input" value={cost.supplierPrice} onChange={(e) => setCost({ ...cost, supplierPrice: e.target.value })} /></Field>
                <Field label="Supplier shipping"><input className="input" value={cost.supplierShipping} onChange={(e) => setCost({ ...cost, supplierShipping: e.target.value })} /></Field>
                <Field label="Packaging"><input className="input" value={cost.packaging} onChange={(e) => setCost({ ...cost, packaging: e.target.value })} /></Field>
                <Field label="Ships from (country)"><input className="input" maxLength={2} value={shipsFrom} onChange={(e) => setShipsFrom(e.target.value.toUpperCase())} /></Field>
              </div>
            )}
            <Field label="Marketplace"><select className="input" value={f.marketplace} onChange={(e) => setF({ ...f, marketplace: e.target.value })}>{Object.entries(MARKETPLACE_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label={`Selling price (${cur})`}><input className="input" value={f.unitPrice} onChange={(e) => setF({ ...f, unitPrice: e.target.value })} /></Field>
              <Field label="Quantity"><input className="input" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} /></Field>
              <Field label="Shipping charged"><input className="input" value={f.shippingCharged} onChange={(e) => setF({ ...f, shippingCharged: e.target.value })} /></Field>
              <Field label="Seller discount"><input className="input" value={f.sellerDiscount} onChange={(e) => setF({ ...f, sellerDiscount: e.target.value })} /></Field>
              <Field label="Postage / fulfilment"><input className="input" value={f.fulfilmentCost} onChange={(e) => setF({ ...f, fulfilmentCost: e.target.value })} /></Field>
              <Field label="Advertising"><input className="input" value={f.advertisingCost} onChange={(e) => setF({ ...f, advertisingCost: e.target.value })} /></Field>
              <Field label="Other expenses"><input className="input" value={f.otherExpenses} onChange={(e) => setF({ ...f, otherExpenses: e.target.value })} /></Field>
              <Field label="Category ID"><input className="input" value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })} /></Field>
            </div>
            <button className="btn-primary w-full justify-center" disabled={mode === 'sku' && !variant} onClick={calc}>Calculate profit</button>
          </div>
        </Card>

        <Card title="Breakdown" className="lg:col-span-2" actions={b && <StatusBadge status={b.status} />}>
          {!b ? <p className="text-sm text-ink2">Enter inputs and calculate.</p> : (
            <div className="grid gap-4 md:grid-cols-2">
              <table className="w-full text-sm">
                <tbody>
                  {ROWS.map(([k, label, neg]) => (
                    <tr key={k} className={k === 'netRevenue' ? 'font-semibold' : ''}><td className="py-1 text-ink2">{label}</td><td className="num py-1">{neg && Number(b[k]) !== 0 ? '−' : ''}{money(b[k], b.currency)}</td></tr>
                  ))}
                  <tr className="border-t border-line text-base font-semibold"><td className="py-2">Net profit</td><td className="num py-2" style={{ color: Number(b.netProfit) < 0 ? 'var(--critical)' : undefined }}>{money(b.netProfit, b.currency)}</td></tr>
                  <tr><td className="text-ink2">Net margin</td><td className="num">{pct(b.netMarginPercent)}</td></tr>
                  <tr><td className="text-ink2">Return on product cost</td><td className="num">{pct(b.returnOnCostPercent)}</td></tr>
                  {b.reporting && <tr><td className="text-ink2">Net profit in {b.reporting.currency}</td><td className="num">{money(b.reporting.netProfit, b.reporting.currency)}</td></tr>}
                </tbody>
              </table>
              <div className="space-y-3 text-sm">
                {res!.alerts.map((a) => <Alert key={a.code} tone={a.severity === 'critical' ? 'critical' : 'warning'}>{a.message}</Alert>)}
                {b.warnings.map((w) => <Alert key={w}>{w}</Alert>)}
                <p><strong>Minimum profitable price:</strong> {money(res!.minimumProfitablePrice, b.currency)}</p>
                <div><strong>Fees</strong><ul className="text-xs text-ink2">{b.feeLines.map((fl, i) => <li key={i}>{fl.name}: {money(fl.amount, b.currency)} — {fl.explanation} ({fl.source})</li>)}</ul></div>
                {b.fxConversions.length > 0 && <div><strong>Exchange rates used</strong><ul className="text-xs text-ink2">{b.fxConversions.map((x, i) => <li key={i}>1 {x.from} = {Number(x.rate).toFixed(4)} {x.to} ({x.source}, {new Date(x.asOf).toLocaleDateString('en-GB')})</li>)}</ul></div>}
                <div className="text-xs text-ink2"><strong>VAT:</strong> {res!.assumptions.tax.taxTreatment.replace(/_/g, ' ')} at {res!.assumptions.tax.taxRatePercent}% {res!.assumptions.tax.pricesIncludeTax ? '(prices include VAT)' : '(prices exclude tax)'}<div className="text-muted">{res!.assumptions.tax.taxTreatmentReason}</div></div>
              </div>
            </div>
          )}
        </Card>

        <Card title="Reverse price calculator" className="lg:col-span-2">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Target"><select className="input" value={target.kind} onChange={(e) => setTarget({ ...target, kind: e.target.value })}><option value="margin">Net margin %</option><option value="profit">Net profit ({cur})</option></select></Field>
            <Field label="Value"><input className="input w-28" value={target.value} onChange={(e) => setTarget({ ...target, value: e.target.value })} /></Field>
            <button className="btn-primary" disabled={mode === 'sku' && !variant} onClick={reverse}>Find required price</button>
          </div>
          {rev && (rev.achievable && rev.breakdown ? (
            <p className="mt-3 text-sm">Required selling price: <strong className="text-lg">{money(rev.unitPrice, rev.breakdown.currency)}</strong> → net profit {money(rev.breakdown.netProfit, rev.breakdown.currency)} at {pct(rev.breakdown.netMarginPercent)} margin (rounded up to .99).</p>
          ) : <div className="mt-3"><Alert>{rev.message}</Alert></div>)}
        </Card>

        <Card title="Demonstration example">
          <p className="mb-2 text-xs text-ink2">Illustrative values only — not the company&apos;s actual costs or fee rates.</p>
          <div className="grid grid-cols-2 gap-2">
            {Object.keys(demo).map((k) => (
              <Field key={k} label={k.replace(/([A-Z])/g, ' $1').toLowerCase().replace(/^\w/, (s) => s.toUpperCase())}><input className="input" value={demo[k as keyof typeof demo]} onChange={(e) => setDemo({ ...demo, [k]: e.target.value })} /></Field>
            ))}
          </div>
          <button className="btn mt-2" onClick={async () => setDemoRes(await api.post('/profit/simple', demo))}>Calculate</button>
          {demoRes && <p className="mt-2 text-sm">Net profit <strong>{money(demoRes.netProfit)}</strong> · margin <strong>{pct(demoRes.netMarginPercent)}</strong></p>}
        </Card>
      </div>
    </div>
  );
}
