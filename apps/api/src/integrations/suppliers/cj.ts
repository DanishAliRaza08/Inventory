import { appCredentials, endpoints } from '../../config';
import { ApiCallError, ensureOk, httpRequest } from '../http';
import { permanent } from '../util';
import { SupplierPriceStockResult } from './supplier-types';

/** CJ Dropshipping API v2. The access token is obtained from the account's API key. */
export async function cjAccessToken() {
  const r = ensureOk(await httpRequest({ method: 'POST', url: `${endpoints().cjApi}/authentication/getAccessToken`, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: appCredentials().cj.apiKey }) }), 'CJ access token');
  if (!r.json?.result) permanent('CJ_AUTH', `CJ rejected the API key: ${r.json?.message}`);
  return { accessToken: r.json.data.accessToken as string, accessTokenExpiresAt: r.json.data.accessTokenExpiryDate as string, refreshToken: r.json.data.refreshToken as string };
}

async function cj(token: string, method: 'GET' | 'POST', path: string, body?: unknown) {
  const r = ensureOk(await httpRequest({ method, url: `${endpoints().cjApi}${path}`, headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), `CJ ${path}`);
  if (!r.json?.result) throw new ApiCallError(`CJ ${path}: ${r.json?.message}`, { transient: false, authExpired: r.json?.code === 1600100, code: `CJ_${r.json?.code}`, readable: `CJ Dropshipping: ${r.json?.message}` });
  return r.json.data;
}

export async function cjPriceStock(token: string, vid: string): Promise<SupplierPriceStockResult> {
  const v = await cj(token, 'GET', `/product/variant/queryByVid?vid=${encodeURIComponent(vid)}`);
  const stock: any[] = await cj(token, 'GET', `/product/stock/queryByVid?vid=${encodeURIComponent(vid)}`);
  // Prefer a UK warehouse when it has stock (ships from GB → no import VAT rule).
  const uk = stock.find((s) => s.countryCode === 'GB' && Number(s.storageNum) > 0);
  const best = uk ?? stock.sort((a, b) => Number(b.storageNum) - Number(a.storageNum))[0];
  const qty = Number(best?.storageNum ?? 0);
  return { price: String(v.variantSellPrice), currency: 'USD', reportedQuantity: qty, stockStatus: qty === 0 ? 'OUT_OF_STOCK' : qty < 10 ? 'LOW_STOCK' : 'IN_STOCK', shipsFromCountry: best?.countryCode ?? null };
}

export async function cjPlaceOrder(token: string, o: { vid: string; quantity: number; address: Record<string, string | undefined>; reference: string }) {
  const d = await cj(token, 'POST', '/shopping/order/createOrderV2', {
    orderNumber: o.reference,
    shippingCountryCode: o.address.country,
    shippingCustomerName: o.address.name,
    shippingAddress: o.address.line1,
    shippingAddress2: o.address.line2,
    shippingCity: o.address.city,
    shippingProvince: o.address.region || o.address.city,
    shippingZip: o.address.postcode,
    shippingPhone: o.address.phone,
    logisticName: 'CJPacket',
    fromCountryCode: 'CN',
    products: [{ vid: o.vid, quantity: o.quantity }],
  });
  return { externalOrderId: String(d.orderId) };
}

export async function cjTracking(token: string, orderId: string) {
  const d: any[] = await cj(token, 'GET', `/logistic/trackInfo?orderId=${encodeURIComponent(orderId)}`);
  return d?.[0] ? { trackingNumber: String(d[0].trackingNumber), carrier: String(d[0].logisticName ?? 'CJPacket') } : null;
}
