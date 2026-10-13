'use client';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { ErrorText } from '@/components/ui';

function LoginForm() {
  const params = useSearchParams();
  const [step, setStep] = useState<'password' | 'mfa'>(params.get('mfa') ? 'mfa' : 'password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const next = params.get('next') ?? '/';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (step === 'password') {
        const r = await api.post<{ mfaRequired: boolean }>('/auth/login', { email, password });
        if (r.mfaRequired) setStep('mfa');
        else window.location.href = next;
      } else {
        await api.post('/auth/mfa/verify', { code });
        window.location.href = next;
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-6">
      <div>
        <h1 className="text-lg font-semibold">Fashion Rockstar Ops</h1>
        <p className="text-sm text-ink2">{step === 'password' ? 'Sign in to continue' : 'Enter the 6-digit code from your authenticator app'}</p>
      </div>
      <ErrorText error={error} />
      {step === 'password' ? (
        <>
          <label className="block">
            <span className="label">Email</span>
            <input className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="block">
            <span className="label">Password</span>
            <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        </>
      ) : (
        <label className="block">
          <span className="label">Authentication code</span>
          <input className="input tracking-widest" inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} />
        </label>
      )}
      <button className="btn-primary w-full justify-center" disabled={busy}>
        {busy ? 'Please wait…' : step === 'password' ? 'Sign in' : 'Verify'}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Suspense>
        <LoginForm />
      </Suspense>
    </div>
  );
}
