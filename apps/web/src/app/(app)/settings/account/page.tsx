'use client';
import { useState } from 'react';
import useSWR from 'swr';
import { Alert, Card, ErrorText, Field, PageHeader } from '@/components/ui';
import { api, fetcher } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useMe } from '@/lib/session';

export default function AccountPage() {
  const me = useMe();
  const { data: sessions, mutate } = useSWR<Array<{ id: string; ip: string | null; userAgent: string | null; lastSeenAt: string; createdAt: string }>>('/auth/sessions', fetcher);
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const go = async (fn: () => Promise<unknown>, ok: string) => { setError(null); setMsg(null); try { await fn(); setMsg(ok); } catch (e) { setError(e); } };
  return (
    <div className="max-w-3xl space-y-4">
      <PageHeader title="My security" subtitle={me.email} />
      {msg && <Alert tone="good">{msg}</Alert>}
      <ErrorText error={error} />
      <Card title="Multi-factor authentication">
        {me.mfaEnabled ? <p className="text-sm">✓ MFA is enabled on your account.</p> : setup ? (
          <div className="space-y-2 text-sm">
            <p>Add this key to your authenticator app (Google Authenticator, 1Password, Authy…), then enter the 6-digit code.</p>
            <p className="break-all rounded bg-plane p-2 font-mono text-xs">{setup.secret}</p>
            <p className="break-all text-xs text-muted">{setup.otpauthUrl}</p>
            <Field label="Code"><input className="input w-40" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} /></Field>
            <button className="btn-primary" onClick={() => go(() => api.post('/auth/mfa/confirm', { code }), 'MFA enabled. Other sessions were signed out.')}>Confirm</button>
          </div>
        ) : <button className="btn-primary" onClick={() => go(async () => setSetup(await api.post('/auth/mfa/setup')), '')}>Set up MFA</button>}
      </Card>
      <Card title="Change password">
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Current password"><input className="input" type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></Field>
          <Field label="New password"><input className="input" type="password" autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></Field>
        </div>
        <button className="btn-primary mt-2" onClick={() => go(() => api.post('/auth/password', pw), 'Password changed. Other sessions were signed out.')}>Change password</button>
      </Card>
      <Card title="Active sessions">
        <ul className="space-y-1 text-sm">{sessions?.map((s) => <li key={s.id} className="flex items-center justify-between gap-2"><span>{s.userAgent?.slice(0, 60) ?? 'Unknown device'} · {s.ip} · last seen {dateTime(s.lastSeenAt)}</span><button className="btn" onClick={async () => { await api.del(`/auth/sessions/${s.id}`); void mutate(); }}>Revoke</button></li>)}</ul>
      </Card>
    </div>
  );
}
