import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { config } from '../config';

/** Signed, expiring OAuth `state` that binds the callback to the account and user who started it. */
function key() {
  return createHmac('sha256', Buffer.from(config().APP_ENCRYPTION_KEY, 'base64')).update('oauth-state').digest();
}

export function makeState(payload: { kind: 'account' | 'supplier'; id: string; userId: string }) {
  const body = Buffer.from(JSON.stringify({ ...payload, n: randomBytes(8).toString('hex'), exp: Date.now() + 15 * 60_000 })).toString('base64url');
  return `${body}.${createHmac('sha256', key()).update(body).digest('base64url')}`;
}

export function readState(state: string): { kind: 'account' | 'supplier'; id: string; userId: string } | null {
  const [body, sig] = state.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', key()).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  return p.exp > Date.now() ? p : null;
}
