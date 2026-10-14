import { createHmac } from 'crypto';
import { appCredentials, config, endpoints } from '../../config';
import { ApiCallError, ensureOk, httpRequest } from '../http';
import { permanent } from '../util';
import { SupplierPriceStockResult } from './supplier-types';

/**
 * AliExpress Open Platform (IOP gateway). Signature: HMAC-SHA256(app_secret,
 * [api path for system APIs] + concat(sorted key+value)), upper-case hex.
 * Business APIs are called on /sync with a `method` parameter.
 * Method names below follow the AliExpress dropshipping (DS) API set; confirm them against the
 * documentation shown for the approved app before going live.
 */
export const AE_METHODS = {
  productGet: 'aliexpress.ds.product.get',
  orderCreate: 'aliexpress.ds.order.create',
  trackingGet: 'aliexpress.ds.order.tracking.get',
} as const;

function sign(apiPath: string, params: Record<string, string>) {
  const keys = Object.keys(params).filter((k) => k !== 'sign').sort();
  return createHmac('sha256', appCredentials().aliexpress.appSecret).update(apiPath + keys.map((k) => k + params[k]).join('')).digest('hex').toUpperCase();
}

function base(extra: Record<string, string>): Record<string, string> {
  return { app_key: appCredentials().aliexpress.appKey, timestamp: String(Date.now()), sign_method: 'sha256', ...extra };
}

export function aliexpressAuthorizeUrl(state: string) {
  const q = new URLSearchParams({ response_type: 'code', force_auth: 'true', client_id: appCredentials().aliexpress.appKey, redirect_uri: `${config().PUBLIC_BASE_URL}/api/integrations/oauth/aliexpress/callback`, state });
  return `${endpoints().aliexpressAuthorize}?${q}`;
}

export async function aliexpressExchangeCode(code: string) {
  const path = '/auth/token/create';
  const params = base({ code });
  params.sign = sign(path, params);
  const r = ensureOk(await httpRequest({ method: 'POST', url: `${endpoints().aliexpressApi}${path}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() }), 'AliExpress token');
  if (!r.json?.access_token) permanent('AE_AUTH', `AliExpress authorisation failed: ${r.json?.message ?? r.text.slice(0, 200)}`);
  return { accessToken: r.json.access_token, refreshToken: r.json.refresh_token, accessTokenExpiresAt: new Date(Date.now() + Number(r.json.expires_in) * 1000).toISOString(), account: r.json.account };
}

async function business(token: string, method: string, extra: Record<string, string>) {
  const params = base({ method, access_token: token, ...extra });
  params.sign = sign('', params);
  const r = ensureOk(await httpRequest({ method: 'POST', url: endpoints().aliexpressSync, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() }), `AliExpress ${method}`);
  if (r.json?.code && r.json.code !== '0') {
    throw new ApiCallError(`AliExpress ${method}: ${r.json.message}`, { transient: false, authExpired: /token/i.test(r.json.code), code: `AE_${r.json.code}`, readable: `AliExpress: ${r.json.message}` });
  }
  return r.json;
}

export async function aliexpressPriceStock(token: string, productId: string, skuId?: string | null): Promise<SupplierPriceStockResult> {
  const j = await business(token, AE_METHODS.productGet, { product_id: productId, ship_to_country: 'GB', target_currency: 'USD', target_language: 'en' });
  const result = j.aliexpress_ds_product_get_response?.result;
  const skus: any[] = result?.ae_item_sku_info_dtos?.ae_item_sku_info_d_t_o ?? [];
  const sku = skus.find((s) => !skuId || String(s.sku_id) === String(skuId)) ?? skus[0];
  if (!sku) permanent('AE_NOT_FOUND', `AliExpress product ${productId} not found or has no SKUs.`);
  const offline = result?.ae_item_base_info_dto?.product_status_type && result.ae_item_base_info_dto.product_status_type !== 'onSelling';
  const qty = Number(sku.sku_available_stock ?? 0);
  return {
    price: String(sku.offer_sale_price ?? sku.sku_price),
    currency: sku.currency_code ?? 'USD',
    reportedQuantity: qty,
    stockStatus: offline ? 'DISCONTINUED' : qty === 0 ? 'OUT_OF_STOCK' : qty < 10 ? 'LOW_STOCK' : 'IN_STOCK',
    shipsFromCountry: sku.ships_from_country ?? null,
  };
}

export async function aliexpressPlaceOrder(token: string, o: { productId: string; skuAttr?: string | null; quantity: number; address: Record<string, string | undefined>; reference: string }) {
  const req = {
    out_order_id: o.reference,
    logistics_address: { contact_person: o.address.name, address: o.address.line1, address2: o.address.line2, city: o.address.city, province: o.address.region || o.address.city, zip: o.address.postcode, country: o.address.country, phone_country: '+44', mobile_no: o.address.phone },
    product_items: [{ product_id: o.productId, product_count: o.quantity, sku_attr: o.skuAttr ?? '' }],
  };
  const j = await business(token, AE_METHODS.orderCreate, { param_place_order_request4_open_api_d_t_o: JSON.stringify(req) });
  const id = j.aliexpress_ds_order_create_response?.result?.order_list?.number?.[0];
  if (!id) permanent('AE_ORDER', 'AliExpress did not accept the order.');
  return { externalOrderId: String(id) };
}

export async function aliexpressTracking(token: string, orderId: string) {
  const j = await business(token, AE_METHODS.trackingGet, { ae_order_id: orderId, language: 'en_US' });
  const line = j.aliexpress_ds_order_tracking_get_response?.result?.data?.tracking_detail_line_list?.[0];
  return line ? { trackingNumber: String(line.mail_no), carrier: String(line.carrier_name ?? 'AliExpress') } : null;
}
