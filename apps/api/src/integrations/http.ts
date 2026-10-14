/**
 * Minimal HTTP layer shared by every connector: timeouts, transient/permanent error
 * classification and a per-key token-bucket rate limiter.
 */
export class ApiCallError extends Error {
  constructor(
    message: string,
    public readonly opts: { transient: boolean; code: string; httpStatus?: number; readable: string; body?: unknown; authExpired?: boolean },
  ) {
    super(message);
    this.name = 'ApiCallError';
  }
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  text: string;
  json: any;
}

export async function httpRequest(req: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | Buffer | FormData | URLSearchParams;
  timeoutMs?: number;
}): Promise<HttpResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), req.timeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body as any, signal: ctrl.signal });
  } catch (e) {
    throw new ApiCallError(`Network error calling ${new URL(req.url).host}: ${(e as Error).message}`, {
      transient: true,
      code: 'NETWORK',
      readable: 'The marketplace could not be reached. The operation will be retried automatically.',
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json: any = null;
  if (text && (res.headers.get('content-type') ?? '').includes('json')) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, headers: res.headers, text, json };
}

/** Throw a classified error for non-2xx responses. */
export function ensureOk(res: HttpResponse, context: string, extractMessage?: (r: HttpResponse) => string | undefined): HttpResponse {
  if (res.status >= 200 && res.status < 300) return res;
  const detail = extractMessage?.(res) ?? res.text.slice(0, 500);
  const transient = res.status === 429 || res.status >= 500;
  const authExpired = res.status === 401;
  throw new ApiCallError(`${context} failed with HTTP ${res.status}: ${detail}`, {
    transient,
    authExpired,
    code: `HTTP_${res.status}`,
    httpStatus: res.status,
    body: res.json ?? res.text,
    readable: authExpired
      ? 'The marketplace rejected the saved authorisation. Reconnect the account on the Integrations page.'
      : res.status === 429
        ? 'The marketplace rate limit was reached. The operation will be retried shortly.'
        : transient
          ? 'The marketplace had a temporary problem. The operation will be retried.'
          : `The marketplace rejected the request: ${detail}`,
  });
}

/** Token bucket per key (account + API group), shared within a process. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; updated: number }>();
  constructor(private readonly perSecond: number, private readonly burst: number) {}

  async take(key: string) {
    for (;;) {
      const now = Date.now();
      const b = this.buckets.get(key) ?? { tokens: this.burst, updated: now };
      b.tokens = Math.min(this.burst, b.tokens + ((now - b.updated) / 1000) * this.perSecond);
      b.updated = now;
      if (b.tokens >= 1) {
        b.tokens -= 1;
        this.buckets.set(key, b);
        return;
      }
      this.buckets.set(key, b);
      await new Promise((r) => setTimeout(r, Math.ceil(((1 - b.tokens) / this.perSecond) * 1000)));
    }
  }
}
