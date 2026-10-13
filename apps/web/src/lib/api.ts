/**
 * Browser API client. Requests go to /api on the same origin (proxied to the API service), carry
 * the httpOnly session cookie automatically, and always send the CSRF header the API requires.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public body: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, isForm = false): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'X-Requested-With': 'fr-web', ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? (() => { try { return JSON.parse(text); } catch { return { message: text }; } })() : {};
  if (!res.ok) {
    // Sign-in and MFA endpoints report their own errors; everything else sends the user to sign in.
    if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/auth/login') && !path.startsWith('/auth/mfa')) {
      const code = (json as { code?: string }).code;
      window.location.href = code === 'MFA_REQUIRED' ? '/login?mfa=1' : `/login?next=${encodeURIComponent(window.location.pathname)}`;
    }
    const issues = (json as { issues?: Array<{ path?: string; field?: string; message: string }> }).issues;
    const msg = (json as { message?: string }).message ?? res.statusText;
    throw new ApiError(res.status, (json as { code?: string }).code ?? 'ERROR', issues?.length ? `${msg}: ${issues.map((i) => `${i.path ?? i.field ?? ''} ${i.message}`).join('; ')}` : msg, json);
  }
  return json as T;
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}),
  patch: <T>(p: string, b: unknown) => request<T>('PATCH', p, b),
  put: <T>(p: string, b: unknown) => request<T>('PUT', p, b),
  del: <T>(p: string) => request<T>('DELETE', p),
  upload: <T>(p: string, file: File, field = 'file') => {
    const fd = new FormData();
    fd.append(field, file);
    return request<T>('POST', p, fd, true);
  },
};

export const fetcher = <T>(p: string) => api.get<T>(p);

export function qs(params: Record<string, string | number | boolean | undefined | null>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : '';
}
