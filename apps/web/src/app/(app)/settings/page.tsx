'use client';
import Link from 'next/link';
import { useState } from 'react';
import useSWR from 'swr';
import { Alert, Card, ErrorText, PageHeader } from '@/components/ui';
import { api, fetcher } from '@/lib/api';
import { useCan } from '@/lib/session';

interface Setting { key: string; value: unknown; isDefault: boolean }
const CONTROLS: Record<string, string> = {
  'controls.publishing_enabled': 'Publishing to marketplaces',
  'controls.repricing_enabled': 'Automated repricing',
  'controls.inventory_sync_enabled': 'Automated inventory synchronisation',
  'controls.automation_enabled': 'Automation rules',
};

export default function SettingsPage() {
  const can = useCan();
  const { data, mutate } = useSWR<Setting[]>('/settings', fetcher);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const save = async (key: string, value: unknown) => { setError(null); try { await api.put(`/settings/${key}`, { value }); void mutate(); } catch (e) { setError(e); } };
  const others = data?.filter((s) => !s.key.startsWith('controls.')) ?? [];
  return (
    <div className="max-w-4xl">
      <PageHeader title="Settings" actions={<Link className="btn" href="/settings/account">My security & MFA</Link>} />
      <ErrorText error={error} />
      <Card title="Emergency controls" className="mt-3">
        <p className="mb-3 text-sm text-ink2">Switching a control off stops that automation immediately. No data is deleted; queued work waits until it is switched back on.</p>
        <div className="space-y-2">
          {data?.filter((s) => s.key in CONTROLS).map((s) => (
            <div key={s.key} className="flex items-center justify-between gap-2 rounded border border-line px-3 py-2">
              <span className="text-sm">{CONTROLS[s.key]} — <strong style={{ color: s.value ? 'var(--good-text)' : 'var(--critical)' }}>{s.value ? '● On' : '■ Off'}</strong></span>
              {can('settings.manage') && <button className={s.value ? 'btn-danger' : 'btn-primary'} onClick={() => confirm(`${s.value ? 'Stop' : 'Resume'} ${CONTROLS[s.key]!.toLowerCase()}?`) && save(s.key, !s.value)}>{s.value ? 'Stop' : 'Resume'}</button>}
            </div>
          ))}
        </div>
      </Card>
      <Card title="Thresholds & finance" className="mt-4">
        <Alert tone="info">Thresholds are business choices, not fixed rules. Changes are audited.</Alert>
        <table className="mt-3 w-full"><tbody>{others.map((s) => {
          const isBool = typeof s.value === 'boolean';
          const isNum = typeof s.value === 'number';
          return (
            <tr key={s.key}><td className="td text-sm">{s.key}</td>
              <td className="td">{isBool ? <input type="checkbox" checked={s.value as boolean} disabled={!can('settings.manage')} onChange={(e) => save(s.key, e.target.checked)} aria-label={s.key} />
                : <input className="input w-40" disabled={!can('settings.manage')} value={edits[s.key] ?? String(s.value)} onChange={(e) => setEdits({ ...edits, [s.key]: e.target.value })} aria-label={s.key} />}</td>
              <td className="td">{!isBool && edits[s.key] !== undefined && <button className="btn" onClick={() => save(s.key, isNum ? Number(edits[s.key]) : edits[s.key])}>Save</button>}</td></tr>
          );
        })}</tbody></table>
      </Card>
    </div>
  );
}
