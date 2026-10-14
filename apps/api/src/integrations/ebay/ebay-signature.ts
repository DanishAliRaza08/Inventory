import { createPrivateKey, sign } from 'crypto';
import { config } from '../../config';

/**
 * eBay "digital signatures for APIs" (RFC 9421 HTTP message signatures, Ed25519), required on
 * Finances API calls for UK/EU-domiciled sellers. Keys come from eBay's Key Management API.
 * Returns no headers when keys are not configured (e.g. mock / US-only accounts).
 */
export function ebaySignatureHeaders(method: string, url: string): Record<string, string> {
  const jwe = config().EBAY_SIGNING_KEY_JWE;
  const pem = config().EBAY_SIGNING_PRIVATE_KEY;
  if (!jwe || !pem) return {};
  const u = new URL(url);
  const created = Math.floor(Date.now() / 1000);
  const params = `("x-ebay-signature-key" "@method" "@path" "@authority");created=${created}`;
  const base = [
    `"x-ebay-signature-key": ${jwe}`,
    `"@method": ${method.toUpperCase()}`,
    `"@path": ${u.pathname}`,
    `"@authority": ${u.host}`,
    `"@signature-params": ${params}`,
  ].join('\n');
  const key = createPrivateKey(pem.includes('BEGIN') ? pem : `-----BEGIN PRIVATE KEY-----\n${pem}\n-----END PRIVATE KEY-----`);
  const sig = sign(null, Buffer.from(base), key).toString('base64');
  return { 'x-ebay-signature-key': jwe, 'Signature-Input': `sig1=${params}`, Signature: `sig1=:${sig}:`, 'x-ebay-enforce-signature': 'true' };
}
