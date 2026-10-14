import { ApiCallError } from './http';
import { ConnectorResult } from './connector';

/** Convert thrown API errors into ConnectorResult failures. */
export async function attempt<T>(fn: () => Promise<T>): Promise<ConnectorResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (e instanceof ApiCallError) {
      return { ok: false, transient: e.opts.transient, code: e.opts.code, message: e.message, readable: e.opts.readable, httpStatus: e.opts.httpStatus, authExpired: e.opts.authExpired };
    }
    return { ok: false, transient: true, code: 'CONNECTOR_EXCEPTION', message: (e as Error).message, readable: 'An unexpected error occurred talking to the marketplace; it will be retried.' };
  }
}

export function permanent(code: string, readable: string, message = readable): never {
  throw new ApiCallError(message, { transient: false, code, readable });
}

export const money2 = (n: number | string) => Number(n).toFixed(2);

export function htmlDescription(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br/>')}</p>`)
    .join('');
}

export function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}
