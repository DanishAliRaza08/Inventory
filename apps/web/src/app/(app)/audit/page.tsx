'use client';
import { useState } from 'react';
import useSWR from 'swr';
import { Card, PageHeader, Pager } from '@/components/ui';
import { fetcher, qs } from '@/lib/api';
import { dateTime } from '@/lib/format';

interface Log { id: string; actorEmail: string | null; action: string; entityType: string; entityId: string | null; before: unknown; after: unknown; ip: string | null; createdAt: string }

export default function AuditPage() {
  const [f, setF] = useState({ action: '', entityType: '', page: 1 });
  const { data } = useSWR<{ items: Log[]; total: number }>(`/audit-logs${qs({ ...f, pageSize: 50 })}`, fetcher, { keepPreviousData: true });
  return (
    <div>
      <PageHeader title="Activity & audit log" subtitle="Append-only record of every important change: who, what, when, before and after." />
      <Card>
        <div className="mb-3 flex flex-wrap gap-2">
          <input className="input max-w-xs" placeholder="Action prefix, e.g. listing. or cost." value={f.action} onChange={(e) => setF({ ...f, action: e.target.value, page: 1 })} aria-label="Action" />
          <input className="input max-w-xs" placeholder="Entity type, e.g. listing" value={f.entityType} onChange={(e) => setF({ ...f, entityType: e.target.value, page: 1 })} aria-label="Entity type" />
        </div>
        <div className="overflow-x-auto"><table className="w-full min-w-[800px]"><thead><tr>{['When', 'Who', 'Action', 'Entity', 'Details'].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
          <tbody>{data?.items.map((l) => (
            <tr key={l.id}><td className="td whitespace-nowrap text-xs">{dateTime(l.createdAt)}</td><td className="td text-xs">{l.actorEmail}<div className="text-muted">{l.ip}</div></td><td className="td text-xs font-medium">{l.action}</td><td className="td text-xs">{l.entityType}<div className="text-muted">{l.entityId?.slice(0, 8)}</div></td>
              <td className="td text-xs"><details><summary className="cursor-pointer text-ink2">View</summary><pre className="mt-1 max-h-60 max-w-xl overflow-auto whitespace-pre-wrap text-[11px]">{JSON.stringify({ before: l.before, after: l.after }, null, 2)}</pre></details></td></tr>
          ))}</tbody></table></div>
        {data && <Pager page={f.page} pageSize={50} total={data.total} onPage={(page) => setF({ ...f, page })} />}
      </Card>
    </div>
  );
}
