'use client';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import useSWR from 'swr';
import { Alert, Card, ErrorText, Field, Modal, PageHeader, StatusBadge } from '@/components/ui';
import { api, fetcher, qs } from '@/lib/api';
import { MARKETPLACE_NAMES, ago, dateTime } from '@/lib/format';
import { useCan } from '@/lib/session';

interface Settings { postcode?: string; country?: string; location?: string; paymentPolicyId?: string; warehouseId?: string; defaultProductType?: string; shippingProviderIds?: Record<string, string>; sellerId?: string }
interface Account { id: string; name: string; marketplace: string; environment: string; status: string; connectedAt: string | null; externalAccountId: string | null; settings: Settings | null; syncStates: Array<{ resource: string; status: string; lastSuccessAt: string | null; lastError: string | null }>; credential: { accessTokenExpiresAt: string | null; refreshTokenExpiresAt: string | null } | null }
interface Cap { status: string; api?: string; notes?: string }
interface Caps { mockMode: boolean; matrix: Record<string, Record<string, Cap>>; suppliers: Record<string, Record<string, Cap>>; configured: Record<string, boolean> }
interface Op { id: string; operation: string; status: string; readableError: string | null; errorCode: string | null; httpStatus: number | null; durationMs: number | null; createdAt: string; entityType: string | null; account: { name: string } }

const CAP_STATUS: Record<string, string> = { verified: 'ACTIVE', built: 'VALIDATED', implemented: 'VALIDATED', planned: 'DRAFT', unsupported: 'UNSUPPORTED' };

function IntegrationsInner() {
  const can = useCan();
  const params = useSearchParams();
  const manage = can('integrations.manage');
  const { data: accounts, mutate } = useSWR<Account[]>('/integrations/accounts', fetcher, { refreshInterval: 30_000 });
  const { data: caps } = useSWR<Caps>('/integrations/capabilities', fetcher);
  const [opFilter, setOpFilter] = useState({ accountId: '', status: '' });
  const { data: ops, mutate: mutateOps } = useSWR<Op[]>(`/integrations/operations${qs(opFilter)}`, fetcher, { refreshInterval: 30_000 });
  const [error, setError] = useState<unknown>(params.get('error'));
  const [msg, setMsg] = useState<string | null>(params.get('connected') ? `${params.get('connected')} connected.` : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [settingsFor, setSettingsFor] = useState<Account | null>(null);
  const [settings, setSettings] = useState<Settings>({});
  const [amazonFor, setAmazonFor] = useState<Account | null>(null);
  const [amazon, setAmazon] = useState({ refreshToken: '', sellerId: '' });
  const [newAcc, setNewAcc] = useState({ marketplace: 'EBAY_UK', name: '', environment: 'PRODUCTION' });

  const act = async (key: string, fn: () => Promise<unknown>, done?: (r: any) => string) => {
    setBusy(key); setError(null); setMsg(null);
    try { const r = await fn(); if (done) setMsg(done(r)); void mutate(); void mutateOps(); } catch (e) { setError(e); } finally { setBusy(null); }
  };
  const connect = (a: Account) => act(`c${a.id}`, async () => { const r = await api.get<{ url: string }>(`/integrations/accounts/${a.id}/connect`); window.location.href = r.url; });
  const ops0 = caps ? Object.keys(Object.values(caps.matrix)[0] ?? {}) : [];

  return (
    <div>
      <PageHeader title="Integrations" subtitle="Official marketplace and supplier APIs only. Tokens are encrypted on the server and never sent to the browser." />
      {caps?.mockMode && <div className="mb-3"><Alert tone="warning"><strong>Mock marketplace mode.</strong> All connectors talk to the local mock server with dummy data — nothing reaches eBay, Amazon, TikTok, AliExpress or CJ. Turn off <code>MOCK_MARKETPLACES</code> and add real app credentials to go live (see README).</Alert></div>}
      {msg && <div className="mb-3"><Alert tone="good">{msg}</Alert></div>}
      <ErrorText error={error} />
      {caps && (
        <div className="mb-4 flex flex-wrap gap-2 text-xs">
          {Object.entries(caps.configured).map(([k, v]) => <span key={k} className="rounded border border-line px-2 py-1">{v ? '●' : '○'} {k === 'ai' ? 'AI assistant' : k} app credentials {v ? 'configured' : 'missing'}</span>)}
        </div>
      )}

      <Card title="Marketplace accounts">
        <div className="overflow-x-auto"><table className="w-full min-w-[960px]">
          <thead><tr>{['Account', 'Environment', 'Status', 'Token', 'Last sync', ''].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
          <tbody>{accounts?.map((a) => (
            <tr key={a.id}>
              <td className="td text-sm"><div className="font-medium">{a.name}</div><div className="text-xs text-muted">{MARKETPLACE_NAMES[a.marketplace]}{a.externalAccountId ? ` · ${a.externalAccountId}` : ''}</div></td>
              <td className="td text-xs">{a.environment}</td>
              <td className="td"><StatusBadge status={a.status} />{a.connectedAt && <div className="text-xs text-muted">since {dateTime(a.connectedAt)}</div>}</td>
              <td className="td text-xs">{a.credential?.refreshTokenExpiresAt ? `renew by ${dateTime(a.credential.refreshTokenExpiresAt)}` : a.credential ? 'stored' : '—'}</td>
              <td className="td text-xs">{a.syncStates.length ? a.syncStates.map((s) => <div key={s.resource}>{s.resource}: {ago(s.lastSuccessAt)}{s.lastError && <span style={{ color: 'var(--critical)' }} title={s.lastError}> ■ error</span>}</div>) : 'never'}</td>
              <td className="td">{manage && a.environment !== 'DEMO' && (
                <div className="flex flex-wrap gap-1">
                  {a.status !== 'CONNECTED' && (a.marketplace === 'AMAZON_UK'
                    ? <><button className="btn-primary" disabled={!!busy} onClick={() => connect(a)}>Connect</button><button className="btn" onClick={() => { setAmazonFor(a); setAmazon({ refreshToken: '', sellerId: '' }); }}>Self-authorised…</button></>
                    : <button className="btn-primary" disabled={!!busy} onClick={() => connect(a)}>{a.status === 'EXPIRED' ? 'Reconnect' : 'Connect'}</button>)}
                  {a.status === 'CONNECTED' && <>
                    <button className="btn" disabled={!!busy} onClick={() => act(`t${a.id}`, () => api.post<{ ok: boolean; message: string }>(`/integrations/accounts/${a.id}/test`), (r) => `${a.name}: ${r.message}`)}>Test</button>
                    <button className="btn" disabled={!!busy} onClick={() => act(`o${a.id}`, () => api.post(`/integrations/accounts/${a.id}/sync/orders`), (r) => `${a.name}: orders synced ${JSON.stringify(r)}`)}>Sync orders</button>
                    <button className="btn" disabled={!!busy} onClick={() => act(`f${a.id}`, () => api.post(`/integrations/accounts/${a.id}/sync/finance`), (r) => `${a.name}: finance synced ${JSON.stringify(r)}`)}>Sync fees</button>
                    {can('listings.write') && <button className="btn" disabled={!!busy} onClick={() => act(`a${a.id}`, () => api.post(`/integrations/accounts/${a.id}/adopt-listings`), (r) => `${a.name}: existing listings — ${JSON.stringify(r)}`)}>Import existing listings</button>}
                    <button className="btn" disabled={!!busy} onClick={() => confirm(`Disconnect ${a.name}? Syncing stops until you reconnect.`) && act(`d${a.id}`, () => api.post(`/integrations/accounts/${a.id}/disconnect`), () => `${a.name} disconnected.`)}>Disconnect</button>
                  </>}
                  <button className="btn" onClick={() => { setSettingsFor(a); setSettings(a.settings ?? {}); }}>Settings</button>
                </div>
              )}{a.environment === 'DEMO' && <span className="text-xs text-muted">Demo account (no marketplace calls)</span>}</td>
            </tr>
          ))}</tbody>
        </table></div>
        {manage && (
          <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-line pt-3">
            <Field label="Add account"><select className="input w-auto" value={newAcc.marketplace} onChange={(e) => setNewAcc({ ...newAcc, marketplace: e.target.value })}>{Object.entries(MARKETPLACE_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Name"><input className="input" value={newAcc.name} placeholder="e.g. Fashion Rockstar eBay UK" onChange={(e) => setNewAcc({ ...newAcc, name: e.target.value })} /></Field>
            <Field label="Environment"><select className="input w-auto" value={newAcc.environment} onChange={(e) => setNewAcc({ ...newAcc, environment: e.target.value })}><option value="PRODUCTION">Production</option><option value="SANDBOX">Sandbox</option></select></Field>
            <button className="btn" disabled={!newAcc.name || !!busy} onClick={() => act('new', () => api.post('/integrations/accounts', newAcc), () => 'Account added. Connect it to authorise access.')}>Add</button>
          </div>
        )}
      </Card>

      <Card title="Operations log" className="mt-4" actions={
        <div className="flex gap-1">
          <select className="input w-auto" value={opFilter.accountId} onChange={(e) => setOpFilter({ ...opFilter, accountId: e.target.value })} aria-label="Account"><option value="">All accounts</option>{accounts?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
          <select className="input w-auto" value={opFilter.status} onChange={(e) => setOpFilter({ ...opFilter, status: e.target.value })} aria-label="Status"><option value="">All results</option>{['SUCCEEDED', 'FAILED_TRANSIENT', 'FAILED_PERMANENT', 'UNSUPPORTED'].map((s) => <option key={s} value={s}>{s.replace('_', ' ').toLowerCase()}</option>)}</select>
        </div>}>
        <div className="max-h-[420px] overflow-auto"><table className="w-full min-w-[800px] text-sm">
          <thead><tr>{['When', 'Account', 'Operation', 'Result', 'Details'].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
          <tbody>{ops?.map((o) => (
            <tr key={o.id}><td className="td text-xs">{dateTime(o.createdAt)}</td><td className="td text-xs">{o.account.name}</td><td className="td text-xs">{o.operation.toLowerCase().replace(/_/g, ' ')}</td><td className="td"><StatusBadge status={o.status === 'SUCCEEDED' ? 'SUCCEEDED' : o.status === 'FAILED_TRANSIENT' ? 'FAILED' : o.status} /></td>
              <td className="td text-xs">{o.readableError ?? ''}{o.httpStatus ? ` (HTTP ${o.httpStatus})` : ''}{o.durationMs != null && <span className="text-muted"> · {o.durationMs} ms</span>}</td></tr>
          ))}</tbody>
        </table>{ops?.length === 0 && <p className="py-4 text-center text-sm text-ink2">No marketplace calls yet.</p>}</div>
      </Card>

      <Card title="Capability matrix" className="mt-4">
        <p className="mb-2 text-xs text-ink2"><strong>Verified</strong>: confirmed against the live marketplace. <strong>Built</strong>: implemented and tested against the mock server; becomes verified after the first successful run with your real credentials.</p>
        <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-xs">
          <thead><tr><th className="th">Operation</th>{caps && Object.keys(caps.matrix).map((m) => <th key={m} className="th">{MARKETPLACE_NAMES[m]}</th>)}</tr></thead>
          <tbody>{ops0.map((op) => <tr key={op}><td className="td font-medium">{op.toLowerCase().replace(/_/g, ' ')}</td>{caps && Object.entries(caps.matrix).map(([m, c]) => <td key={m} className="td align-top"><StatusBadge status={CAP_STATUS[c[op]!.status] ?? c[op]!.status.toUpperCase()} /> <span className="text-muted">{c[op]!.status}</span><div className="mt-1 text-muted">{c[op]!.api}</div>{c[op]!.notes && <div className="text-muted">{c[op]!.notes}</div>}</td>)}</tr>)}</tbody>
        </table></div>
      </Card>
      <Card title="Supplier connectors" className="mt-4">
        <p className="mb-2 text-sm text-ink2">Connect AliExpress and CJ from each supplier&apos;s page. Placing supplier orders always needs staff confirmation.</p>
        <div className="overflow-x-auto"><table className="w-full min-w-[700px] text-xs">
          <thead><tr><th className="th">Operation</th>{caps && Object.keys(caps.suppliers).map((k) => <th key={k} className="th">{k.replace('_', ' ')}</th>)}</tr></thead>
          <tbody>{caps && Object.keys(Object.values(caps.suppliers)[0] ?? {}).map((op) => <tr key={op}><td className="td font-medium">{op.toLowerCase().replace(/_/g, ' ')}</td>{Object.entries(caps.suppliers).map(([k, c]) => <td key={k} className="td align-top">{c[op] ? <><StatusBadge status={CAP_STATUS[c[op]!.status] ?? c[op]!.status.toUpperCase()} /> <span className="text-muted">{c[op]!.status}</span><div className="mt-1 text-muted">{c[op]!.api}</div></> : '—'}</td>)}</tr>)}</tbody>
        </table></div>
      </Card>

      <Modal open={!!settingsFor} title={`Settings · ${settingsFor?.name ?? ''}`} onClose={() => setSettingsFor(null)}
        footer={<><button className="btn" onClick={() => setSettingsFor(null)}>Cancel</button><button className="btn-primary" onClick={() => act('s', async () => { await api.patch(`/integrations/accounts/${settingsFor!.id}/settings`, settings); setSettingsFor(null); }, () => 'Settings saved.')}>Save</button></>}>
        {settingsFor && (
          <div className="space-y-3">
            <p className="text-xs text-ink2">These values come from your seller account; none of them are secrets.</p>
            {settingsFor.marketplace.startsWith('EBAY') && <>
              <Field label="Item location postcode" hint="Required by eBay on every listing."><input className="input" value={settings.postcode ?? ''} onChange={(e) => setSettings({ ...settings, postcode: e.target.value })} /></Field>
              <Field label="Item location (town)"><input className="input" value={settings.location ?? ''} onChange={(e) => setSettings({ ...settings, location: e.target.value })} /></Field>
              <Field label="Country code"><input className="input" maxLength={2} value={settings.country ?? ''} onChange={(e) => setSettings({ ...settings, country: e.target.value.toUpperCase() })} /></Field>
              <Field label="Default payment policy ID" hint="eBay Seller Hub → Business policies. Shipping and return policy IDs are set per listing."><input className="input" value={settings.paymentPolicyId ?? ''} onChange={(e) => setSettings({ ...settings, paymentPolicyId: e.target.value })} /></Field>
            </>}
            {settingsFor.marketplace === 'AMAZON_UK' && <>
              <Field label="Seller ID (Merchant token)"><input className="input" value={settings.sellerId ?? ''} onChange={(e) => setSettings({ ...settings, sellerId: e.target.value })} /></Field>
              <Field label="Default product type" hint="e.g. DRESS, SHIRT, PANTS — can be overridden per listing."><input className="input" value={settings.defaultProductType ?? ''} onChange={(e) => setSettings({ ...settings, defaultProductType: e.target.value.toUpperCase() })} /></Field>
            </>}
            {settingsFor.marketplace === 'TIKTOK_UK' && <>
              <Field label="Warehouse ID" hint="TikTok Shop Seller Center → Shipping → Warehouses."><input className="input" value={settings.warehouseId ?? ''} onChange={(e) => setSettings({ ...settings, warehouseId: e.target.value })} /></Field>
              <Field label="Shipping provider IDs" hint="One per line: carrier name = TikTok provider ID (e.g. Royal Mail = 7117858858072016686)">
                <textarea className="input min-h-[80px]" value={Object.entries(settings.shippingProviderIds ?? {}).map(([k, v]) => `${k} = ${v}`).join('\n')}
                  onChange={(e) => setSettings({ ...settings, shippingProviderIds: Object.fromEntries(e.target.value.split('\n').map((l) => l.split('=').map((x) => x.trim())).filter((p) => p[0] && p[1])) })} />
              </Field>
            </>}
          </div>
        )}
      </Modal>

      <Modal open={!!amazonFor} title="Amazon self-authorised connection" onClose={() => setAmazonFor(null)}
        footer={<><button className="btn" onClick={() => setAmazonFor(null)}>Cancel</button><button className="btn-primary" disabled={amazon.refreshToken.length < 10 || amazon.sellerId.length < 3} onClick={() => act('amz', async () => { const r = await api.post<{ ok: boolean; message: string }>(`/integrations/accounts/${amazonFor!.id}/credentials`, amazon); setAmazonFor(null); return r; }, (r) => (r.ok ? 'Amazon connected and tested.' : `Saved, but the test failed: ${r.message}`))}>Save and test</button></>}>
        <div className="space-y-3">
          <p className="text-sm text-ink2">For a private app you authorised yourself in Seller Central (Apps & Services → Develop apps → Authorise). The refresh token is encrypted on the server and never shown again.</p>
          <Field label="Seller ID"><input className="input" value={amazon.sellerId} onChange={(e) => setAmazon({ ...amazon, sellerId: e.target.value })} /></Field>
          <Field label="LWA refresh token"><input className="input" type="password" autoComplete="off" value={amazon.refreshToken} onChange={(e) => setAmazon({ ...amazon, refreshToken: e.target.value })} /></Field>
        </div>
      </Modal>
    </div>
  );
}

export default function IntegrationsPage() {
  return <Suspense><IntegrationsInner /></Suspense>;
}
