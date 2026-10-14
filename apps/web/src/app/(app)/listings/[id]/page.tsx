'use client';
import { use, useEffect, useState } from 'react';
import useSWR from 'swr';
import { Alert, Card, ErrorText, Field, PageHeader, StatusBadge } from '@/components/ui';
import { ImageCheck, ImageCheckResult } from '@/components/image-check';
import { api, fetcher } from '@/lib/api';
import { MARKETPLACE_NAMES, dateTime, money } from '@/lib/format';
import { useCan } from '@/lib/session';

const TITLE_MAX: Record<string, number> = { EBAY_UK: 80, EBAY_US: 80, AMAZON_UK: 200, TIKTOK_UK: 255 };

interface Content {
  title: string; description: string; bulletPoints: string[]; categoryId: string | null; categoryName: string | null; condition: string | null;
  attributes: Record<string, string | string[]>; requiredAttributes: string[]; verifiedAttributes: string[]; imageIds: string[];
  shippingPolicyId: string | null; returnPolicyId: string | null; dispatchTimeDays: number | null; quantityPolicy: string | null; brand: string | null; gtin: string | null;
  identifierExemption: boolean; searchKeywords: string[]; handlingInstructions: string | null; notes: string | null; complianceSignedOff: boolean;
  paymentPolicyId: string | null; productType: string | null;
}
interface Issue { code: string; field: string; severity: string; blocking: boolean; message: string }
interface Listing {
  id: string; sku: string; marketplace: string; status: string; price: string | null; currency: string; externalListingId: string | null; lastError: string | null;
  currentVersionId: string; publishedVersionId: string | null; createdById: string | null;
  account: { name: string; environment: string; status: string };
  variant: { id: string; sku: string }; product: { id: string; title: string; restricted: boolean; images: Array<{ id: string; url: string; width: number | null; height: number | null; checkResult: ImageCheckResult | null; checkedAt: string | null }> };
  versions: Array<{ id: string; version: number; content: Content; createdAt: string; submittedAt: string | null; approvedAt: string | null; rejectedAt: string | null; reviewNote: string | null; validations: Array<{ valid: boolean; complete: boolean; blockingCount: number; issues: Issue[]; ranAt: string }> }>;
  statusHistory: Array<{ id: string; fromStatus: string; toStatus: string; event: string; note: string | null; createdAt: string }>;
  operations: Array<{ id: string; operation: string; status: string; errorCode: string | null; readableError: string | null; nextAction: string | null; createdAt: string; retryCount: number }>;
}

interface Suggestion { title: string; description: string; bulletPoints: string[]; searchKeywords: string[]; categorySuggestion: { name: string; reason: string } | null; missingInformation: Array<{ field: string; why: string }>; claimsNeedingVerification: string[]; warnings: string[] }

const EDITABLE = ['INCOMPLETE', 'DRAFT', 'VALIDATION_FAILED', 'AWAITING_APPROVAL', 'APPROVED', 'PUBLICATION_FAILED'];

export default function ListingBuilder({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const can = useCan();
  const { data: l, mutate } = useSWR<Listing>(`/listings/${id}`, fetcher, { refreshInterval: (d) => (d?.status === 'PUBLISHING' ? 3000 : 0) });
  const [c, setC] = useState<Content | null>(null);
  const [price, setPrice] = useState('');
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [ai, setAi] = useState<{ source: string; suggestion: Suggestion } | null>(null);
  const [aiNote, setAiNote] = useState('');
  const [aiBusy, setAiBusy] = useState(false);

  const current = l?.versions.find((v) => v.id === l.currentVersionId);
  useEffect(() => {
    if (current && !dirty) { setC(current.content); setPrice(l?.price ?? ''); }
  }, [current, l?.price, dirty]);

  if (!l || !c || !current) return <p className="text-sm text-ink2">Loading…</p>;
  const validation = current.validations[0];
  const editable = EDITABLE.includes(l.status) && can('listings.write');
  const upd = (patch: Partial<Content>) => { setC({ ...c, ...patch }); setDirty(true); };
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); setDirty(false); await mutate(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const save = () => run(() => api.patch(`/listings/${id}`, { content: { ...c, complianceSignedOff: undefined }, price: price || null }));
  const images = c.imageIds.map((iid) => l.product.images.find((i) => i.id === iid)).filter(Boolean) as Listing['product']['images'];
  const titleMax = TITLE_MAX[l.marketplace] ?? 80;
  const attrs = Object.entries(c.attributes);

  return (
    <div>
      <PageHeader
        title={c.title || l.product.title}
        subtitle={<>{MARKETPLACE_NAMES[l.marketplace]} · {l.account.name} · SKU {l.sku} · version {current.version}{l.externalListingId && <> · Marketplace ID <strong>{l.externalListingId}</strong></>}</>}
        actions={<StatusBadge status={l.status} />}
      />
      {l.account.environment === 'DEMO' && <div className="mb-3"><Alert>Demo account: publishing is simulated and never reaches a marketplace.</Alert></div>}
      {l.lastError && <div className="mb-3"><Alert tone="critical"><strong>Last marketplace response:</strong> {l.lastError}</Alert></div>}
      {current.reviewNote && current.rejectedAt && <div className="mb-3"><Alert>Rejected: {current.reviewNote}</Alert></div>}
      {l.publishedVersionId && l.publishedVersionId !== l.currentVersionId && <div className="mb-3"><Alert tone="info">You are editing a revision. The live listing keeps the published version until this one is approved and republished.</Alert></div>}
      <ErrorText error={error} />

      <div className="mt-3 grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Content" actions={editable && <button className="btn-primary" disabled={!dirty || busy} onClick={save}>Save draft</button>}>
            <fieldset disabled={!editable} className="space-y-3">
              <Field label={`Title (${c.title.length}/${titleMax})`}>
                <input className="input" value={c.title} onChange={(e) => upd({ title: e.target.value })} style={c.title.length > titleMax ? { borderColor: 'var(--critical)' } : undefined} />
              </Field>
              <Field label="Description"><textarea className="input min-h-32" value={c.description} onChange={(e) => upd({ description: e.target.value })} /></Field>
              {l.marketplace === 'AMAZON_UK' && (
                <Field label="Bullet points (one per line, max 5)"><textarea className="input min-h-24" value={c.bulletPoints.join('\n')} onChange={(e) => upd({ bulletPoints: e.target.value.split('\n').filter((x) => x.trim()) })} /></Field>
              )}
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Selling price" hint={l.currency}><input className="input" inputMode="decimal" value={price} onChange={(e) => { setPrice(e.target.value); setDirty(true); }} /></Field>
                <Field label="Category ID"><input className="input" value={c.categoryId ?? ''} onChange={(e) => upd({ categoryId: e.target.value || null })} /></Field>
                <Field label="Condition">
                  <select className="input" value={c.condition ?? ''} onChange={(e) => upd({ condition: e.target.value || null })}>
                    <option value="">—</option><option value="NEW">New with tags</option><option value="NEW_OTHER">New without tags</option><option value="USED">Used</option>
                  </select>
                </Field>
                <Field label="Dispatch time (days)"><input className="input" inputMode="numeric" value={c.dispatchTimeDays ?? ''} onChange={(e) => upd({ dispatchTimeDays: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
                <Field label="Quantity policy">
                  <select className="input" value={c.quantityPolicy ?? ''} onChange={(e) => upd({ quantityPolicy: e.target.value || null })}>
                    <option value="SYNC">Synchronise with availability</option><option value="FIXED">Fixed quantity</option><option value="MANUAL">Manual</option>
                  </select>
                </Field>
                {(l.marketplace === 'EBAY_UK' || l.marketplace === 'EBAY_US') && <>
                  <Field label="Shipping policy ID"><input className="input" value={c.shippingPolicyId ?? ''} onChange={(e) => upd({ shippingPolicyId: e.target.value || null })} /></Field>
                  <Field label="Return policy ID"><input className="input" value={c.returnPolicyId ?? ''} onChange={(e) => upd({ returnPolicyId: e.target.value || null })} /></Field>
                  <Field label="Payment policy ID" hint="Blank uses the account default"><input className="input" value={c.paymentPolicyId ?? ''} onChange={(e) => upd({ paymentPolicyId: e.target.value || null })} /></Field>
                </>}
                {l.marketplace === 'AMAZON_UK' && <Field label="Amazon product type" hint="e.g. DRESS, SHIRT"><input className="input" value={c.productType ?? ''} onChange={(e) => upd({ productType: e.target.value.toUpperCase() || null })} /></Field>}
                <Field label="Brand"><input className="input" value={c.brand ?? ''} onChange={(e) => upd({ brand: e.target.value || null })} /></Field>
                <Field label="GTIN / EAN / UPC"><input className="input" value={c.gtin ?? ''} onChange={(e) => upd({ gtin: e.target.value || null })} /></Field>
              </div>
              {l.marketplace === 'AMAZON_UK' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={c.identifierExemption} onChange={(e) => upd({ identifierExemption: e.target.checked })} /> Approved GTIN exemption on this account</label>}
              <Field label="Search keywords (comma separated)"><input className="input" value={c.searchKeywords.join(', ')} onChange={(e) => upd({ searchKeywords: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} /></Field>
            </fieldset>
          </Card>

          <Card title="Item specifics / attributes">
            <fieldset disabled={!editable}>
              <table className="w-full">
                <thead><tr><th className="th">Attribute</th><th className="th">Value</th><th className="th">Required</th><th className="th">Verified</th></tr></thead>
                <tbody>
                  {[...new Set([...c.requiredAttributes, ...attrs.map(([k]) => k)])].map((k) => (
                    <tr key={k}>
                      <td className="td text-sm">{k}</td>
                      <td className="td"><input className="input" value={String(c.attributes[k] ?? '')} onChange={(e) => upd({ attributes: { ...c.attributes, [k]: e.target.value } })} aria-label={k} /></td>
                      <td className="td text-xs">{c.requiredAttributes.includes(k) ? 'Required' : ''}</td>
                      <td className="td"><input type="checkbox" aria-label={`${k} verified`} checked={c.verifiedAttributes.includes(k)} onChange={(e) => upd({ verifiedAttributes: e.target.checked ? [...c.verifiedAttributes, k] : c.verifiedAttributes.filter((x) => x !== k) })} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-2 flex flex-wrap gap-2">
                <button className="btn" disabled={busy || dirty} title={dirty ? 'Save first' : undefined} onClick={() => run(() => api.post(`/listings/${id}/category-attributes`))}>Load required attributes from {MARKETPLACE_NAMES[l.marketplace]}</button>
                <input className="input max-w-xs" placeholder="Add attribute name" id="newattr" />
                <button className="btn" onClick={() => { const el = document.getElementById('newattr') as HTMLInputElement; if (el.value) { upd({ attributes: { ...c.attributes, [el.value]: '' } }); el.value = ''; } }}>Add</button>
              </div>
              <p className="mt-2 text-xs text-ink2">Tick "Verified" only when the value is confirmed from the product or supplier evidence. Category-required attributes come from the marketplace's category metadata.</p>
            </fieldset>
          </Card>

          <Card title={`Images (${images.length})`} actions={editable && images.length > 0 && <button className="btn" disabled={busy} onClick={() => run(async () => { for (const img of images) await api.post(`/ai/images/${img.id}/check`); if (['INCOMPLETE', 'DRAFT', 'VALIDATION_FAILED'].includes(l.status)) await api.post(`/listings/${id}/validate`); })}>Check images</button>}>
            {images.length === 0 && <Alert tone="critical">No images selected.</Alert>}
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
              {images.map((img, i) => (
                <figure key={img.id}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img.url} alt="" className="aspect-square w-full rounded border border-line object-cover" />
                  <figcaption className="flex justify-between text-xs text-muted">
                    <span>{i === 0 ? 'Main' : `#${i + 1}`}</span>
                    {editable && i > 0 && <button onClick={() => { const ids = [...c.imageIds]; [ids[i - 1], ids[i]] = [ids[i]!, ids[i - 1]!]; upd({ imageIds: ids }); }} aria-label="Move earlier">◀</button>}
                  </figcaption>
                  <ImageCheck result={img.checkResult} checkedAt={img.checkedAt} />
                </figure>
              ))}
            </div>
            {editable && l.product.images.some((i) => !c.imageIds.includes(i.id)) && (
              <div className="mt-2 text-sm">Add: {l.product.images.filter((i) => !c.imageIds.includes(i.id)).map((i) => <button key={i.id} className="btn mr-1" onClick={() => upd({ imageIds: [...c.imageIds, i.id] })}>+ image {i.width}×{i.height}</button>)}</div>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Workflow">
            <div className="flex flex-col gap-2">
              {dirty && <Alert>Unsaved changes. Save before submitting.</Alert>}
              {['INCOMPLETE', 'DRAFT', 'VALIDATION_FAILED'].includes(l.status) && can('listings.write') && <button className="btn" disabled={busy || dirty} onClick={() => run(() => api.post(`/listings/${id}/validate`))}>Run validation</button>}
              {l.status === 'DRAFT' && can('listings.submit') && <button className="btn-primary" disabled={busy || dirty} onClick={() => run(() => api.post(`/listings/${id}/submit`))}>Submit for approval</button>}
              {l.status === 'AWAITING_APPROVAL' && can('listings.approve') && <>
                {l.product.restricted && !c.complianceSignedOff && <button className="btn" disabled={busy || !note} onClick={() => run(() => api.post(`/listings/${id}/compliance-signoff`, { note }))}>Sign off compliance</button>}
                <textarea className="input" placeholder="Review note (required to reject or sign off)" value={note} onChange={(e) => setNote(e.target.value)} />
                <button className="btn-primary" disabled={busy} onClick={() => run(() => api.post(`/listings/${id}/approve`, { note: note || undefined }))}>Approve</button>
                <button className="btn" disabled={busy || !note} onClick={() => run(() => api.post(`/listings/${id}/reject`, { note }))}>Reject</button>
              </>}
              {l.status === 'APPROVED' && can('listings.publish') && <button className="btn-primary" disabled={busy} onClick={() => confirm(`Publish ${l.sku} to ${l.account.name} at ${money(l.price, l.currency)}?`) && run(() => api.post(`/listings/${id}/publish`))}>Publish to {MARKETPLACE_NAMES[l.marketplace]}</button>}
              {l.status === 'PUBLISHING' && <Alert tone="info">Waiting for the marketplace to confirm…</Alert>}
              {l.status === 'PUBLICATION_FAILED' && can('listings.publish') && <button className="btn-primary" disabled={busy} onClick={() => run(() => api.post(`/listings/${id}/retry`))}>Retry publication</button>}
              {['ACTIVE', 'PAUSED', 'ENDED', 'PUBLICATION_FAILED'].includes(l.status) && can('listings.write') && <button className="btn" disabled={busy} onClick={() => run(() => api.post(`/listings/${id}/revise`))}>Revise listing</button>}
              {l.status === 'ACTIVE' && can('listings.end') && <><button className="btn" disabled={busy} onClick={() => run(() => api.post(`/listings/${id}/pause`))}>Pause</button><button className="btn-danger" disabled={busy} onClick={() => confirm('End this listing on the marketplace?') && run(() => api.post(`/listings/${id}/end`))}>End listing</button></>}
              {l.status === 'PAUSED' && can('listings.end') && <button className="btn" disabled={busy} onClick={() => run(() => api.post(`/listings/${id}/resume`))}>Resume</button>}
              {['INCOMPLETE', 'DRAFT', 'VALIDATION_FAILED', 'ENDED', 'PUBLICATION_FAILED'].includes(l.status) && can('listings.write') && <button className="btn" disabled={busy} onClick={() => confirm('Archive this listing?') && run(() => api.post(`/listings/${id}/archive`))}>Archive</button>}
            </div>
          </Card>

          {editable && (
            <Card title="AI listing assistant">
              <p className="mb-2 text-xs text-ink2">Suggests copy from the catalogue facts only. Nothing is applied until you click a button below and save.</p>
              <input className="input mb-2" placeholder="Optional instructions, e.g. emphasise the fabric" value={aiNote} onChange={(e) => setAiNote(e.target.value)} aria-label="Instructions for the AI assistant" />
              <button className="btn" disabled={aiBusy} onClick={async () => { setAiBusy(true); setError(null); try { setAi(await api.post(`/ai/listings/${id}/suggest`, { instructions: aiNote || undefined })); } catch (e) { setError(e); } finally { setAiBusy(false); } }}>{aiBusy ? 'Thinking…' : 'Suggest content'}</button>
              {ai && (() => { const s = ai.suggestion; return (
                <div className="mt-3 space-y-3 text-sm">
                  {ai.source === 'demo' && <Alert tone="info">Demo suggestion — set ANTHROPIC_API_KEY for AI-written copy.</Alert>}
                  {s.warnings.map((w) => <Alert key={w}>{w}</Alert>)}
                  <div><div className="label">Title ({s.title.length}/{titleMax})</div><div>{s.title}</div><button className="btn mt-1" onClick={() => upd({ title: s.title })}>Use title</button></div>
                  <div><div className="label">Description</div><p className="line-clamp-6 whitespace-pre-wrap text-xs">{s.description}</p><button className="btn mt-1" onClick={() => upd({ description: s.description })}>Use description</button></div>
                  {s.bulletPoints.length > 0 && <div><div className="label">Bullet points</div><ul className="list-disc pl-4 text-xs">{s.bulletPoints.map((b) => <li key={b}>{b}</li>)}</ul><button className="btn mt-1" onClick={() => upd({ bulletPoints: s.bulletPoints })}>Use bullet points</button></div>}
                  {s.searchKeywords.length > 0 && <div><div className="label">Keywords</div><div className="text-xs">{s.searchKeywords.join(', ')}</div><button className="btn mt-1" onClick={() => upd({ searchKeywords: s.searchKeywords })}>Use keywords</button></div>}
                  {s.categorySuggestion && <div className="text-xs"><span className="label">Category idea</span>{s.categorySuggestion.name} — {s.categorySuggestion.reason}</div>}
                  {s.missingInformation.length > 0 && <div><div className="label">Missing information</div><ul className="text-xs">{s.missingInformation.map((m) => <li key={m.field}>▲ <strong>{m.field}</strong>: {m.why}</li>)}</ul></div>}
                  {s.claimsNeedingVerification.length > 0 && <div><div className="label">Check before publishing</div><ul className="text-xs">{s.claimsNeedingVerification.map((x) => <li key={x}>▲ {x}</li>)}</ul></div>}
                </div>
              ); })()}
            </Card>
          )}

          <Card title="Checks">
            {!validation ? <p className="text-sm text-ink2">Not validated yet.</p> : (
              <div className="space-y-2">
                <p className="text-sm">{validation.valid && validation.blockingCount === 0 ? <span style={{ color: 'var(--good-text)' }}>✓ Ready for approval</span> : <span style={{ color: 'var(--critical)' }}>■ {validation.issues.filter((i) => i.blocking).length} issue(s) to resolve</span>}</p>
                <ul className="space-y-1.5 text-sm">
                  {validation.issues.map((i, n) => (
                    <li key={n} className="flex gap-1.5">
                      <span aria-hidden style={{ color: i.severity === 'error' ? 'var(--critical)' : i.severity === 'warning' ? 'var(--serious)' : 'var(--text-muted)' }}>{i.severity === 'error' ? '■' : i.severity === 'warning' ? '▲' : 'ℹ'}</span>
                      <span><span className="sr-only">{i.severity}: </span>{i.message}{i.blocking && i.severity === 'warning' && <span className="text-xs text-muted"> (blocks approval)</span>}</span>
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-muted">Checked {dateTime(validation.ranAt)}</p>
              </div>
            )}
          </Card>

          <Card title="Preview">
            <div className="rounded border border-line p-3">
              {images[0] && /* eslint-disable-next-line @next/next/no-img-element */ <img src={images[0].url} alt="" className="mb-2 aspect-square w-full rounded object-cover" />}
              <div className="text-sm font-medium">{c.title}</div>
              <div className="mt-1 text-lg font-semibold">{money(price, l.currency)}</div>
              {c.bulletPoints.length > 0 && <ul className="mt-2 list-disc pl-4 text-xs">{c.bulletPoints.map((b) => <li key={b}>{b}</li>)}</ul>}
              <p className="mt-2 line-clamp-6 whitespace-pre-wrap text-xs text-ink2">{c.description}</p>
            </div>
          </Card>

          <Card title="History">
            <ul className="space-y-1.5 text-xs">
              {l.statusHistory.map((h) => <li key={h.id}><span className="text-muted">{dateTime(h.createdAt)}</span> · {h.event.toLowerCase().replace(/_/g, ' ')} → <strong>{h.toStatus.toLowerCase().replace(/_/g, ' ')}</strong>{h.note ? ` — ${h.note}` : ''}</li>)}
            </ul>
            {l.operations.length > 0 && <>
              <h3 className="mb-1 mt-3 text-xs font-semibold text-ink2">Marketplace operations</h3>
              <ul className="space-y-1.5 text-xs">{l.operations.map((o) => <li key={o.id}><StatusBadge status={o.status} /> {o.operation} · {dateTime(o.createdAt)}{o.readableError && <div className="text-ink2">{o.readableError}</div>}{o.nextAction && <div className="text-muted">Next: {o.nextAction}</div>}</li>)}</ul>
            </>}
          </Card>
        </div>
      </div>
    </div>
  );
}
