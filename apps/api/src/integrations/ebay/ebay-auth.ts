import { appCredentials, endpoints } from '../../config';
import { ensureOk, httpRequest } from '../http';
import { ConnectorContext } from '../connector';
import { permanent } from '../util';

export const EBAY_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  'https://api.ebay.com/oauth/api_scope/sell.finances',
];

function basic() {
  const { clientId, clientSecret } = appCredentials().ebay;
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

export function ebayAuthorizeUrl(state: string) {
  const { clientId, ruName } = appCredentials().ebay;
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: ruName, response_type: 'code', scope: EBAY_SCOPES.join(' '), state, prompt: 'login' });
  return `${endpoints().ebayAuthorize}?${q}`;
}

function toCredentials(j: any, prevRefresh?: string, prevRefreshExpiry?: string) {
  return {
    accessToken: j.access_token,
    accessTokenExpiresAt: new Date(Date.now() + (j.expires_in ?? 7200) * 1000).toISOString(),
    refreshToken: j.refresh_token ?? prevRefresh,
    refreshTokenExpiresAt: j.refresh_token_expires_in ? new Date(Date.now() + j.refresh_token_expires_in * 1000).toISOString() : prevRefreshExpiry,
  };
}

/** Authorization-code exchange after the seller consents. */
export async function ebayExchangeCode(code: string) {
  const res = ensureOk(
    await httpRequest({
      method: 'POST',
      url: endpoints().ebayToken,
      headers: { Authorization: basic(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: appCredentials().ebay.ruName }).toString(),
    }),
    'eBay token exchange',
  );
  return toCredentials(res.json);
}

/** User access token, refreshed (and persisted) when it is about to expire. */
export async function ebayUserToken(ctx: ConnectorContext): Promise<string> {
  const c = ctx.credentials;
  if (!c?.accessToken) permanent('NOT_CONNECTED', 'This eBay account is not connected. Connect it on the Integrations page.');
  if (c.accessTokenExpiresAt && new Date(c.accessTokenExpiresAt).getTime() - Date.now() > 60_000) return c.accessToken;
  if (!c.refreshToken) permanent('AUTH_EXPIRED', 'The eBay authorisation has expired. Reconnect the account.');
  const res = ensureOk(
    await httpRequest({
      method: 'POST',
      url: endpoints().ebayToken,
      headers: { Authorization: basic(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refreshToken, scope: EBAY_SCOPES.join(' ') }).toString(),
    }),
    'eBay token refresh',
  );
  const next = { ...c, ...toCredentials(res.json, c.refreshToken, c.refreshTokenExpiresAt) };
  await ctx.saveCredentials(next);
  ctx.credentials = next;
  return next.accessToken;
}

let appToken: { token: string; expires: number } | null = null;

/** Application token (client credentials) for public APIs such as Taxonomy. */
export async function ebayAppToken(): Promise<string> {
  if (appToken && appToken.expires - Date.now() > 60_000) return appToken.token;
  const res = ensureOk(
    await httpRequest({
      method: 'POST',
      url: endpoints().ebayToken,
      headers: { Authorization: basic(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'https://api.ebay.com/oauth/api_scope' }).toString(),
    }),
    'eBay application token',
  );
  appToken = { token: res.json.access_token, expires: Date.now() + (res.json.expires_in ?? 7200) * 1000 };
  return appToken.token;
}
