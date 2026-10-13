'use client';
import { createContext, useContext } from 'react';
import useSWR from 'swr';
import { fetcher } from './api';

export interface Me {
  id: string;
  email: string;
  name: string;
  roles: string[];
  permissions: string[];
  mfaEnabled: boolean;
  mfaVerified: boolean;
  mfaEnrolmentRequired: boolean;
  demoMode: boolean;
}

const Ctx = createContext<Me | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const { data } = useSWR<Me>('/auth/me', fetcher, { revalidateOnFocus: false });
  if (!data) return <div className="p-8 text-sm text-ink2">Loading…</div>;
  return <Ctx.Provider value={data}>{children}</Ctx.Provider>;
}

export function useMe() {
  const me = useContext(Ctx);
  if (!me) throw new Error('useMe outside SessionProvider');
  return me;
}

/** UI hint only; the API enforces every permission. */
export function useCan() {
  const me = useMe();
  return (p: string) => me.permissions.includes(p);
}
