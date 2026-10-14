'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { Alert, Card, ErrorText, Field, PageHeader } from '@/components/ui';
import { api, fetcher, qs } from '@/lib/api';
import { MARKETPLACE_NAMES } from '@/lib/format';
import { useCan } from '@/lib/session';

interface Template { id: string; name: string; marketplace: string; titleTemplate: string; descriptionTemplate: string; bulletTemplates: string[]; isDefault: boolean; updatedAt: string }
interface BuiltIn { title: string; description: string; bullets: string[] }
interface Preview { sku: string; title: string; description: string; bulletPoints: string[]; attributes: Record<string, string>; notes: string[] }
interface Draft { id?: string; name: string; marketplace: string; titleTemplate: string; descriptionTemplate: string; bulletTemplates: string[]; isDefault: boolean }

const VARIABLES = ['title', 'brand', 'colour', 'size', 'material', 'category', 'description', 'sku'];
const TITLE_MAX: Record<string, number> = { EBAY_UK: 80, EBAY_US: 80, AMAZON_UK: 200, TIKTOK_UK: 255 };

export default function TemplatesPage() {
  const can = useCan();
  const editable = can('listings.write');
  const { data: templates, mutate } = useSWR<Template[]>('/listings/templates', fetcher);
  const { data: builtIn } = useSWR<Record<string, BuiltIn>>('/listings/templates/built-in', fetcher);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [skuSearch, setSkuSearch] = useState('');
  const { data: found } = useSWR<{ variants: Array<{ id: string; sku: string; product: { title: string } }> }>(draft && skuSearch.length >= 2 ? `/search${qs({ q: skuSearch })}` : null, fetcher);
  const skus = found?.variants.slice(0, 8);
  const [variant, setVariant] = useState<{ id: string; sku: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const startFrom = (marketplace: string, t?: Template) => {
    const b = builtIn?.[marketplace];
    setDraft(t ? { id: t.id, name: t.name, marketplace: t.marketplace, titleTemplate: t.titleTemplate, descriptionTemplate: t.descriptionTemplate, bulletTemplates: t.bulletTemplates, isDefault: t.isDefault }
      : { name: '', marketplace, titleTemplate: b?.title ?? '{{title}}', descriptionTemplate: b?.description ?? '{{description}}', bulletTemplates: b?.bullets ?? [], isDefault: false });
    setPreview(null); setMsg(null); setError(null);
  };

  // Live preview against the chosen SKU (debounced).
  useEffect(() => {
    if (!draft || !variant || !draft.titleTemplate) return;
    const h = setTimeout(async () => {
      try {
        setPreview(await api.post<Preview>('/listings/templates/preview', { variantId: variant.id, marketplace: draft.marketplace, titleTemplate: draft.titleTemplate, descriptionTemplate: draft.descriptionTemplate, bulletTemplates: draft.bulletTemplates }));
      } catch (e) { setError(e); }
    }, 400);
    return () => clearTimeout(h);
  }, [draft, variant]);

  const save = async () => {
    if (!draft) return;
    setError(null);
    try {
      const { id, ...body } = draft;
      if (id) await api.put(`/listings/templates/${id}`, body); else await api.post('/listings/templates', body);
      setMsg(`Template “${draft.name}” saved. New drafts for ${MARKETPLACE_NAMES[draft.marketplace]} can use it; existing drafts are not changed.`);
      setDraft(null); void mutate();
    } catch (e) { setError(e); }
  };
  const remove = async (t: Template) => {
    if (!confirm(`Delete template “${t.name}”? Existing drafts keep their content.`)) return;
    try { await api.del(`/listings/templates/${t.id}`); void mutate(); } catch (e) { setError(e); }
  };

  return (
    <div>
      <PageHeader title="Listing templates" subtitle="Templates turn master product data into marketplace titles, descriptions and bullet points when drafts are created. Missing facts are left out, never invented."
        actions={<Link className="btn" href="/listings/new">Listing builder</Link>} />
      {msg && <div className="mb-3"><Alert tone="good">{msg}</Alert></div>}
      <ErrorText error={error} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Templates" className="lg:col-span-1">
          {Object.entries(MARKETPLACE_NAMES).map(([mp, name]) => (
            <div key={mp} className="mb-4">
              <div className="mb-1 flex items-center justify-between"><span className="label mb-0">{name}</span>{editable && <button className="btn" onClick={() => startFrom(mp)}>New</button>}</div>
              <ul className="space-y-1 text-sm">
                {templates?.filter((t) => t.marketplace === mp).map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-2">
                    <button className="truncate text-left hover:underline" onClick={() => startFrom(mp, t)}>{t.name}{t.isDefault && <span className="ml-1 text-xs text-muted">(default)</span>}</button>
                    {editable && <button className="text-xs text-ink2 hover:underline" onClick={() => remove(t)}>Delete</button>}
                  </li>
                ))}
                {templates && !templates.some((t) => t.marketplace === mp) && <li className="text-xs text-muted">Using the built-in template</li>}
              </ul>
            </div>
          ))}
        </Card>

        <div className="min-w-0 space-y-4 lg:col-span-2">
          {!draft ? <Card><p className="text-sm text-ink2">Choose a template to edit, or press New to start from the built-in one.</p></Card> : (
            <>
              <Card title={draft.id ? `Edit · ${draft.name}` : `New ${MARKETPLACE_NAMES[draft.marketplace]} template`} actions={editable && <div className="flex gap-1"><button className="btn" onClick={() => setDraft(null)}>Cancel</button><button className="btn-primary" disabled={!draft.name || !draft.titleTemplate} onClick={save}>Save template</button></div>}>
                <fieldset disabled={!editable} className="space-y-3">
                  <Field label="Name"><input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
                  <Field label="Title" hint={`Limit ${TITLE_MAX[draft.marketplace]} characters on ${MARKETPLACE_NAMES[draft.marketplace]}; longer titles are shortened at a word boundary and flagged.`}>
                    <input className="input font-mono text-xs" value={draft.titleTemplate} onChange={(e) => setDraft({ ...draft, titleTemplate: e.target.value })} />
                  </Field>
                  <Field label="Description"><textarea className="input min-h-32 font-mono text-xs" value={draft.descriptionTemplate} onChange={(e) => setDraft({ ...draft, descriptionTemplate: e.target.value })} /></Field>
                  {draft.marketplace === 'AMAZON_UK' && (
                    <Field label="Bullet points (one template per line, max 5)"><textarea className="input min-h-24 font-mono text-xs" value={draft.bulletTemplates.join('\n')} onChange={(e) => setDraft({ ...draft, bulletTemplates: e.target.value.split('\n').slice(0, 5) })} /></Field>
                  )}
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.isDefault} onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })} /> Default for {MARKETPLACE_NAMES[draft.marketplace]} drafts</label>
                  <div className="text-xs text-ink2">
                    Variables: {VARIABLES.map((v) => <code key={v} className="mr-1 rounded bg-plane px-1">{`{{${v}}}`}</code>)}
                    <div className="mt-1">Wrap optional text in a section so it disappears when the value is missing: <code className="rounded bg-plane px-1">{'{{#material}}Material: {{material}}{{/material}}'}</code></div>
                  </div>
                </fieldset>
              </Card>

              <Card title="Preview with a real SKU">
                <div className="relative mb-3">
                  <input className="input" placeholder="Search SKU or product" value={skuSearch} onChange={(e) => setSkuSearch(e.target.value)} aria-label="Preview SKU" />
                  {skus && skus.length > 0 && skuSearch.length >= 2 && (
                    <ul className="absolute z-10 mt-1 w-full rounded border border-line bg-surface shadow">
                      {skus.map((v) => <li key={v.id}><button className="w-full px-3 py-1.5 text-left text-sm hover:bg-plane" onClick={() => { setVariant(v); setSkuSearch(''); }}>{v.sku} · {v.product.title}</button></li>)}
                    </ul>
                  )}
                </div>
                {!variant ? <p className="text-sm text-ink2">Pick a SKU to see the rendered listing.</p> : !preview ? <p className="text-sm text-ink2">Rendering…</p> : (
                  <div className="space-y-2 text-sm">
                    <div className="text-xs text-muted">{preview.sku}</div>
                    {preview.notes.map((n) => <Alert key={n}>{n}</Alert>)}
                    <div className="font-medium">{preview.title} <span className="text-xs text-muted">({preview.title.length}/{TITLE_MAX[draft.marketplace]})</span></div>
                    {preview.bulletPoints.length > 0 && <ul className="list-disc pl-5 text-xs">{preview.bulletPoints.map((b) => <li key={b}>{b}</li>)}</ul>}
                    <p className="whitespace-pre-wrap text-xs text-ink2">{preview.description}</p>
                    <div className="text-xs text-muted">Attributes: {Object.entries(preview.attributes).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'none'}</div>
                  </div>
                )}
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
