import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { endpoints } from '../../config';
import { ApiCallError, RateLimiter, ensureOk, httpRequest } from '../http';
import { asArray } from '../util';

/** Trading API compatibility level sent with every call. */
export const TRADING_COMPAT_LEVEL = '1349';
export const SITE_IDS = { EBAY_UK: '3', EBAY_US: '0' } as const;

const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', format: false, cdataPropName: '__cdata' });
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, isArray: (name) => ['Errors', 'Item', 'NameValueList', 'PictureURL', 'InventoryStatus'].includes(name) });
const limiter = new RateLimiter(5, 10);

export interface TradingError {
  ShortMessage?: string;
  LongMessage?: string;
  ErrorCode?: string;
  SeverityCode?: string;
  ErrorClassification?: string;
}

/**
 * Calls one Trading API verb (XML over HTTPS) with the OAuth user token in
 * X-EBAY-API-IAF-TOKEN. `Failure` acks become classified errors; `Warning` acks succeed.
 */
export async function tradingCall(call: string, site: keyof typeof SITE_IDS, token: string, body: Record<string, unknown>, rateKey: string) {
  await limiter.take(rateKey);
  const xml =
    '<?xml version="1.0" encoding="utf-8"?>' +
    builder.build({ [`${call}Request`]: { '@_xmlns': 'urn:ebay:apis:eBLBaseComponents', ErrorLanguage: 'en_GB', WarningLevel: 'High', ...body } });
  const res = ensureOk(
    await httpRequest({
      method: 'POST',
      url: endpoints().ebayTrading,
      headers: {
        'Content-Type': 'text/xml',
        'X-EBAY-API-CALL-NAME': call,
        'X-EBAY-API-SITEID': SITE_IDS[site],
        'X-EBAY-API-COMPATIBILITY-LEVEL': TRADING_COMPAT_LEVEL,
        'X-EBAY-API-IAF-TOKEN': token,
      },
      body: xml,
    }),
    `eBay ${call}`,
  );
  const doc = parser.parse(res.text)?.[`${call}Response`];
  if (!doc) throw new ApiCallError(`eBay ${call}: unexpected response`, { transient: true, code: 'BAD_RESPONSE', readable: 'eBay returned an unexpected response; retrying.' });
  const errors = asArray<TradingError>(doc.Errors).filter((e) => e.SeverityCode === 'Error');
  if (doc.Ack === 'Failure' || errors.length) {
    const system = errors.some((e) => e.ErrorClassification === 'SystemError');
    const tokenProblem = errors.some((e) => ['931', '932', '21916984', '21917053'].includes(String(e.ErrorCode)));
    const msg = errors.map((e) => `${e.ErrorCode}: ${e.LongMessage ?? e.ShortMessage}`).join('; ') || 'Unknown error';
    throw new ApiCallError(`eBay ${call} failed: ${msg}`, {
      transient: system,
      authExpired: tokenProblem,
      code: `EBAY_${errors[0]?.ErrorCode ?? 'FAILURE'}`,
      body: errors,
      readable: `eBay rejected the request: ${errors.map((e) => e.LongMessage ?? e.ShortMessage).join(' ')}`,
    });
  }
  return doc;
}
