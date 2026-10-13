'use client';
import useSWR from 'swr';
import { Alert, Card, PageHeader, StatusBadge } from '@/components/ui';
import { fetcher } from '@/lib/api';
import { MARKETPLACE_NAMES, ago } from '@/lib/format';

interface Account { id: string; name: string; marketplace: string; environment: string; status: string; connectedAt: string | null; syncStates: Array<{ resource: string; lastSuccessAt: string | null; lastError: string | null }>; credential: { accessTokenExpiresAt: string | null } | null }
interface Caps { matrix: Record<string, Record<string, { status: string; api?: string; notes?: string }>> }

export default function IntegrationsPage() {
  const { data: accounts } = useSWR<Account[]>('/integrations/accounts', fetcher);
  const { data: caps } = useSWR<Caps>('/integrations/capabilities', fetcher);
  const ops = caps ? Object.keys(Object.values(caps.matrix)[0] ?? {}) : [];
  return (
    <div>
      <PageHeader title="Integrations" subtitle="Official marketplace APIs only. Tokens are encrypted on the server and never sent to the browser." />
      <div className="mb-4"><Alert tone="info">Marketplace connectors are scheduled for Phase 3. Until an operation is implemented and verified against the marketplace for your account, it is shown as <strong>planned</strong> and publishing to that marketplace is refused rather than simulated.</Alert></div>
      <Card title="Marketplace accounts">
        <table className="w-full"><thead><tr>{['Account', 'Marketplace', 'Environment', 'Status', 'Last sync', ''].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
          <tbody>{accounts?.map((a) => (
            <tr key={a.id}><td className="td text-sm">{a.name}</td><td className="td text-sm">{MARKETPLACE_NAMES[a.marketplace]}</td><td className="td text-xs">{a.environment}</td><td className="td"><StatusBadge status={a.status} /></td>
              <td className="td text-xs">{a.syncStates.length ? a.syncStates.map((s) => `${s.resource}: ${ago(s.lastSuccessAt)}`).join(' · ') : 'never'}</td>
              <td className="td">{a.environment !== 'DEMO' && <button className="btn" disabled title="Available when the connector is implemented (Phase 3)">{a.status === 'EXPIRED' ? 'Reconnect' : 'Connect'}</button>}</td></tr>
          ))}</tbody></table>
      </Card>
      <Card title="Capability matrix" className="mt-4">
        <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-xs">
          <thead><tr><th className="th">Operation</th>{caps && Object.keys(caps.matrix).map((m) => <th key={m} className="th">{MARKETPLACE_NAMES[m]}</th>)}</tr></thead>
          <tbody>{ops.map((op) => <tr key={op}><td className="td font-medium">{op.toLowerCase().replace(/_/g, ' ')}</td>{caps && Object.entries(caps.matrix).map(([m, c]) => <td key={m} className="td align-top"><StatusBadge status={c[op]!.status.toUpperCase()} /><div className="mt-1 text-muted">{c[op]!.api}</div>{c[op]!.notes && <div className="text-muted">{c[op]!.notes}</div>}</td>)}</tr>)}</tbody>
        </table></div>
      </Card>
    </div>
  );
}
