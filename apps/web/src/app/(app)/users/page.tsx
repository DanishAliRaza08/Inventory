'use client';
import { useState } from 'react';
import useSWR from 'swr';
import { Card, ErrorText, Field, PageHeader, StatusBadge } from '@/components/ui';
import { api, fetcher } from '@/lib/api';
import { dateTime } from '@/lib/format';

interface User { id: string; email: string; name: string; status: string; mfaEnabled: boolean; lastLoginAt: string | null; roles: Array<{ role: { key: string; name: string } }> }
interface Role { id: string; key: string; name: string; description: string; isSystem: boolean; requiresMfa: boolean; permissions: Array<{ permissionKey: string }>; _count: { users: number } }

export default function UsersPage() {
  const { data: users, mutate } = useSWR<User[]>('/users', fetcher);
  const { data: roles, mutate: mRoles } = useSWR<Role[]>('/roles', fetcher);
  const { data: perms } = useSWR<Array<{ key: string; description: string }>>('/permissions', fetcher);
  const [n, setN] = useState({ name: '', email: '', password: '', roleKeys: [] as string[] });
  const [role, setRole] = useState({ key: '', name: '', permissions: [] as string[] });
  const [error, setError] = useState<unknown>(null);
  const go = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); void mutate(); void mRoles(); } catch (e) { setError(e); } };

  return (
    <div>
      <PageHeader title="Users & permissions" subtitle="Permissions are enforced by the server on every request." />
      <ErrorText error={error} />
      <div className="mt-3 grid gap-4 lg:grid-cols-3">
        <Card title="Staff" className="lg:col-span-2">
          <table className="w-full"><thead><tr>{['Name', 'Roles', 'MFA', 'Last sign-in', 'Status', ''].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
            <tbody>{users?.map((u) => (
              <tr key={u.id}><td className="td text-sm">{u.name}<div className="text-xs text-muted">{u.email}</div></td><td className="td text-xs">{u.roles.map((r) => r.role.name).join(', ')}</td><td className="td text-xs">{u.mfaEnabled ? '✓ on' : 'off'}</td><td className="td text-xs">{dateTime(u.lastLoginAt)}</td>
                <td className="td"><StatusBadge status={u.status} /></td>
                <td className="td"><button className="btn" onClick={() => go(() => api.patch(`/users/${u.id}`, { status: u.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' }))}>{u.status === 'ACTIVE' ? 'Disable' : 'Enable'}</button></td></tr>
            ))}</tbody></table>
        </Card>
        <Card title="Add staff member">
          <div className="space-y-2">
            <Field label="Name"><input className="input" value={n.name} onChange={(e) => setN({ ...n, name: e.target.value })} /></Field>
            <Field label="Email"><input className="input" type="email" value={n.email} onChange={(e) => setN({ ...n, email: e.target.value })} /></Field>
            <Field label="Temporary password" hint="At least 12 characters with upper, lower case and digits."><input className="input" type="password" autoComplete="new-password" value={n.password} onChange={(e) => setN({ ...n, password: e.target.value })} /></Field>
            <fieldset><legend className="label">Roles</legend>{roles?.map((r) => <label key={r.key} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={n.roleKeys.includes(r.key)} onChange={(e) => setN({ ...n, roleKeys: e.target.checked ? [...n.roleKeys, r.key] : n.roleKeys.filter((k) => k !== r.key) })} />{r.name}</label>)}</fieldset>
            <button className="btn-primary" disabled={!n.email || !n.password || !n.roleKeys.length} onClick={() => go(async () => { await api.post('/users', n); setN({ name: '', email: '', password: '', roleKeys: [] }); })}>Create account</button>
          </div>
        </Card>
        <Card title="Roles" className="lg:col-span-2">
          <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-xs">
            <thead><tr><th className="th">Permission</th>{roles?.map((r) => <th key={r.key} className="th text-center">{r.name}</th>)}</tr></thead>
            <tbody>{perms?.map((p) => <tr key={p.key}><td className="td text-xs" title={p.description}>{p.key}</td>{roles?.map((r) => <td key={r.key} className="td text-center">{r.permissions.some((x) => x.permissionKey === p.key) ? '✔' : ''}</td>)}</tr>)}</tbody>
          </table></div>
        </Card>
        <Card title="Custom role">
          <div className="space-y-2">
            <Field label="Key (e.g. warehouse_staff)"><input className="input" value={role.key} onChange={(e) => setRole({ ...role, key: e.target.value.replace(/[^a-z_]/g, '') })} /></Field>
            <Field label="Name"><input className="input" value={role.name} onChange={(e) => setRole({ ...role, name: e.target.value })} /></Field>
            <div className="max-h-60 overflow-auto rounded border border-line p-2">{perms?.map((p) => <label key={p.key} className="flex items-center gap-2 text-xs" title={p.description}><input type="checkbox" checked={role.permissions.includes(p.key)} onChange={(e) => setRole({ ...role, permissions: e.target.checked ? [...role.permissions, p.key] : role.permissions.filter((k) => k !== p.key) })} />{p.key}</label>)}</div>
            <button className="btn-primary" disabled={!role.key || !role.name} onClick={() => go(() => api.put(`/roles/${role.key}`, { name: role.name, permissions: role.permissions }))}>Save role</button>
          </div>
        </Card>
      </div>
    </div>
  );
}
