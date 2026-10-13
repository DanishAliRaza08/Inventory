const SYMBOL: Record<string, string> = { GBP: '£', USD: '$', EUR: '€' };

/** Format a decimal string from the API; never parse money into floats for arithmetic. */
export function money(amount: string | number | null | undefined, currency = 'GBP') {
  if (amount === null || amount === undefined || amount === '') return '—';
  const n = Number(amount);
  const s = SYMBOL[currency];
  const body = Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '-' : ''}${s ?? ''}${body}${s ? '' : ` ${currency}`}`;
}

export function pct(v: string | number | null | undefined) {
  if (v === null || v === undefined) return '—';
  return `${Number(v).toFixed(1)}%`;
}

export function dateTime(v: string | null | undefined) {
  if (!v) return '—';
  return new Date(v).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

export function ago(v: string | null | undefined) {
  if (!v) return 'never';
  const s = (Date.now() - new Date(v).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export const MARKETPLACE_NAMES: Record<string, string> = { EBAY_UK: 'eBay UK', EBAY_US: 'eBay USA', AMAZON_UK: 'Amazon UK', TIKTOK_UK: 'TikTok Shop UK' };
export const MARKETPLACE_CURRENCY: Record<string, string> = { EBAY_UK: 'GBP', EBAY_US: 'USD', AMAZON_UK: 'GBP', TIKTOK_UK: 'GBP' };
