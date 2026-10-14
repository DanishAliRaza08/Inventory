'use client';
import { useState } from 'react';
import useSWR from 'swr';
import { Alert, Card, ErrorText, Field, Modal, PageHeader, StatusBadge } from '@/components/ui';
import { api, fetcher } from '@/lib/api';
import { ago, dateTime } from '@/lib/format';

interface Kind { key: string; label: string; actions: string[]; defaults: Record<string, number> }
interface Run { id: string; status: string; summary: { matched?: number; actions?: string[]; sample?: Array<{ summary: string }>; skipped?: string } | null; startedAt: string }
interface Rule { id: string; name: string; trigger: string; conditions: Record<string, number>; actions: { action: string; notifyRole: string }; schedule: string | null; enabled: boolean; requiresApproval: boolean; lastRunAt: string | null; runs: Run[] }

const ACTION_LABEL: Record<string, string> = { NOTIFY: 'Notify', PROPOSE_REPRICE: 'Propose new prices', PAUSE_LISTINGS: 'Pause affected listings' };
const ROLES = ['owner', 'inventory_manager', 'listing_manager', 'listing_approver', 'order_manager', 'finance_manager'];
const COND_LABEL: Record<string, string> = { minMarginPercent: 'Minimum margin %', percent: 'Increase of at least %', withinHours: 'Within hours', olderThanHours: 'Older than hours' };

interface Draft { id?: string; name: string; kind: string; conditions: Record<string, number>; action: string; notifyRole: string; everyMinutes: number; enabled: boolean; requiresApproval: boolean }

export default function AutomationPage() {
  const { data: kinds } = useSWR<Kind[]>('/automation/kinds', fetcher);
  const { data: rules, mutate } = useSWR<Rule[]>('/automation/rules', fetcher);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const kindOf = (k: string) => kinds?.find((x) => x.key === k);

  const save = async () => {
    if (!draft) return;
    setError(null);
    try {
      const { id, ...body } = draft;
      if (id) await api.put(`/automation/rules/${id}`, body); else await api.post('/automation/rules', body);
      setDraft(null); void mutate();
    } catch (e) { setError(e); }
  };
  const run = async (r: Rule) => {
    setError(null); setMsg(null);
    try {
      const s = await api.post<{ matched?: number; skipped?: string }>(`/automation/rules/${r.id}/run`);
      setMsg(s.skipped ? `${r.name}: skipped (${s.skipped}).` : `${r.name}: ${s.matched ?? 0} match${s.matched === 1 ? '' : 'es'}.`);
      void mutate();
    } catch (e) { setError(e); }
  };
  const edit = (r: Rule) => setDraft({ id: r.id, name: r.name, kind: r.trigger, conditions: r.conditions, action: r.actions.action, notifyRole: r.actions.notifyRole, everyMinutes: Number(r.schedule ?? 60), enabled: r.enabled, requiresApproval: r.requiresApproval });

  return (
    <div>
      <PageHeader title="Automation rules" subtitle="Rules run on a schedule in the background worker. Thresholds are yours to set; pausing listings only happens automatically when you turn off “Requires approval”."
        actions={<button className="btn-primary" disabled={!kinds} onClick={() => { const k = kinds![0]!; setDraft({ name: '', kind: k.key, conditions: k.defaults, action: k.actions[0]!, notifyRole: 'owner', everyMinutes: 60, enabled: false, requiresApproval: true }); }}>New rule</button>} />
      {msg && <div className="mb-3"><Alert tone="info">{msg}</Alert></div>}
      <ErrorText error={error} />
      <div className="space-y-3">
        {rules?.length === 0 && <Card><p className="text-sm text-ink2">No rules yet.</p></Card>}
        {rules?.map((r) => (
          <Card key={r.id} title={<span className="flex items-center gap-2">{r.name}<StatusBadge status={r.enabled ? 'ACTIVE' : 'PAUSED'} /></span>}
            actions={<div className="flex gap-1"><button className="btn" onClick={() => run(r)}>Run now</button><button className="btn" onClick={() => edit(r)}>Edit</button></div>}>
            <div className="text-sm text-ink2">
              {kindOf(r.trigger)?.label ?? r.trigger} · {ACTION_LABEL[r.actions.action] ?? r.actions.action} · notify {r.actions.notifyRole.replace('_', ' ')} · every {r.schedule} min
              {r.actions.action === 'PAUSE_LISTINGS' && <> · {r.requiresApproval ? 'needs approval before pausing' : <strong>pauses automatically</strong>}</>}
            </div>
            {Object.keys(r.conditions).length > 0 && <div className="mt-1 text-xs text-muted">{Object.entries(r.conditions).map(([k, v]) => `${COND_LABEL[k] ?? k}: ${v}`).join(' · ')}</div>}
            <div className="mt-2 text-xs text-ink2">Last run {ago(r.lastRunAt)}</div>
            {r.runs.length > 0 && (
              <ul className="mt-1 space-y-1 text-xs">
                {r.runs.map((x) => (
                  <li key={x.id}><span className="text-muted">{dateTime(x.startedAt)}</span> · <StatusBadge status={x.status} /> {x.summary?.skipped ? `skipped: ${x.summary.skipped}` : `${x.summary?.matched ?? 0} matched`}{x.summary?.actions?.length ? ` · ${x.summary.actions.join(', ')}` : ''}
                    {x.summary?.sample?.slice(0, 3).map((s, i) => <div key={i} className="whitespace-pre-line pl-4 text-muted">{s.summary}</div>)}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ))}
      </div>

      <Modal open={!!draft} title={draft?.id ? 'Edit rule' : 'New rule'} onClose={() => setDraft(null)}
        footer={<><button className="btn" onClick={() => setDraft(null)}>Cancel</button><button className="btn-primary" disabled={!draft?.name} onClick={save}>Save rule</button></>}>
        {draft && (
          <div className="space-y-3">
            <Field label="Name"><input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
            <Field label="When">
              <select className="input" value={draft.kind} onChange={(e) => { const k = kindOf(e.target.value)!; setDraft({ ...draft, kind: k.key, conditions: k.defaults, action: k.actions[0]! }); }}>
                {kinds?.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
              </select>
            </Field>
            {Object.keys(draft.conditions).map((c) => (
              <Field key={c} label={COND_LABEL[c] ?? c}><input className="input" type="number" value={draft.conditions[c]} onChange={(e) => setDraft({ ...draft, conditions: { ...draft.conditions, [c]: Number(e.target.value) } })} /></Field>
            ))}
            <Field label="Then">
              <select className="input" value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })}>
                {kindOf(draft.kind)?.actions.map((a) => <option key={a} value={a}>{ACTION_LABEL[a] ?? a}</option>)}
              </select>
            </Field>
            <Field label="Notify"><select className="input" value={draft.notifyRole} onChange={(e) => setDraft({ ...draft, notifyRole: e.target.value })}>{ROLES.map((r) => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}</select></Field>
            <Field label="Run every (minutes)" hint="15 minutes to 7 days."><input className="input" type="number" min={15} max={10080} value={draft.everyMinutes} onChange={(e) => setDraft({ ...draft, everyMinutes: Number(e.target.value) })} /></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> Enabled</label>
            {draft.action === 'PAUSE_LISTINGS' && (
              <>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.requiresApproval} onChange={(e) => setDraft({ ...draft, requiresApproval: e.target.checked })} /> Requires approval (notify only; a person pauses the listings)</label>
                {!draft.requiresApproval && <Alert tone="warning">This rule will pause live listings on the marketplaces without asking. The publishing emergency switch still overrides it.</Alert>}
              </>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
