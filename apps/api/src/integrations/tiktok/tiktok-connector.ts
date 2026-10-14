import { createHmac } from 'crypto';
import { appCredentials, endpoints } from '../../config';
import { ApiCallError, RateLimiter, ensureOk, httpRequest } from '../http';
import {
  Capability,
  ConnectorContext,
  ExistingListing,
  FinancialBatch,
  MarketplaceConnector,
  NormalizedOrder,
  OPERATIONS,
  Operation,
  PublishPayload,
} from '../connector';
import { attempt, htmlDescription, money2, permanent } from '../util';

const limiter = new RateLimiter(5, 10);

/**
 * TikTok Shop request signature: HMAC-SHA256(app_secret,
 *   app_secret + path + concat(sorted(key+value), excluding sign & access_token) + body + app_secret), hex.
 */
export function tiktokSign(path: string, query: Record<string, string>, body: string, secret: string) {
  const keys = Object.keys(query).filter((k) => k !== 'sign' && k !== 'access_token').sort();
  const base = secret + path + keys.map((k) => k + query[k]).join('') + body + secret;
  return createHmac('sha256', secret).update(base).digest('hex');
}

export function tiktokAuthorizeUrl(state: string) {
  return `${endpoints().tiktokAuthorize}?${new URLSearchParams({ service_id: appCredentials().tiktok.serviceId, state })}`;
}

function tokenCredentials(d: any) {
  return {
    accessToken: d.access_token,
    accessTokenExpiresAt: new Date(Number(d.access_token_expire_in) * 1000).toISOString(),
    refreshToken: d.refresh_token,
    refreshTokenExpiresAt: new Date(Number(d.refresh_token_expire_in) * 1000).toISOString(),
    sellerName: d.seller_name,
  };
}

async function tokenCall(params: Record<string, string>) {
  const { appKey, appSecret } = appCredentials().tiktok;
  const r = ensureOk(await httpRequest({ method: 'GET', url: `${endpoints().tiktokAuth}/api/v2/token/get?${new URLSearchParams({ app_key: appKey, app_secret: appSecret, ...params })}` }), 'TikTok token');
  if (r.json?.code !== 0) permanent('TIKTOK_AUTH', `TikTok rejected the authorisation: ${r.json?.message}`);
  return tokenCredentials(r.json.data);
}

export async function tiktokExchangeCode(code: string) {
  const creds = await tokenCall({ auth_code: code, grant_type: 'authorized_code' });
  // Find the UK shop's cipher, required on every shop-scoped call.
  const shops = await rawCall(creds.accessToken, 'GET', '/authorization/202309/shops', {}, undefined, false);
  const shop = (shops.shops ?? []).find((s: any) => s.region === 'GB') ?? shops.shops?.[0];
  if (!shop) permanent('NO_SHOP', 'No TikTok Shop is authorised for this app.');
  return { ...creds, shopCipher: shop.cipher, shopId: shop.id };
}

async function token(ctx: ConnectorContext): Promise<string> {
  const c = ctx.credentials;
  if (!c?.accessToken) permanent('NOT_CONNECTED', 'This TikTok Shop is not connected. Connect it on the Integrations page.');
  if (new Date(c.accessTokenExpiresAt).getTime() - Date.now() > 3_600_000) return c.accessToken;
  const fresh = await tokenCall({ refresh_token: c.refreshToken, grant_type: 'refresh_token' });
  const next = { ...c, ...fresh };
  await ctx.saveCredentials(next);
  ctx.credentials = next;
  return next.accessToken;
}

async function rawCall(accessToken: string, method: string, path: string, query: Record<string, string>, body?: unknown, shopScoped = true, cipher?: string, form?: FormData) {
  const { appKey, appSecret } = appCredentials().tiktok;
  const q: Record<string, string> = { app_key: appKey, timestamp: String(Math.floor(Date.now() / 1000)), ...query };
  if (shopScoped && cipher) q.shop_cipher = cipher;
  const bodyText = body === undefined || form ? '' : JSON.stringify(body);
  q.sign = tiktokSign(path, q, bodyText, appSecret);
  const res = ensureOk(
    await httpRequest({
      method,
      url: `${endpoints().tiktokApi}${path}?${new URLSearchParams(q)}`,
      headers: { 'x-tts-access-token': accessToken, ...(form ? {} : { 'Content-Type': 'application/json' }) },
      body: form ?? (bodyText || undefined),
    }),
    `TikTok ${method} ${path}`,
  );
  if (res.json?.code !== 0) {
    const transient = [36009004, 36009008].includes(res.json?.code);
    throw new ApiCallError(`TikTok ${path} error ${res.json?.code}: ${res.json?.message}`, {
      transient,
      authExpired: res.json?.code === 105002,
      code: `TIKTOK_${res.json?.code}`,
      readable: `TikTok Shop rejected the request: ${res.json?.message}`,
    });
  }
  return res.json.data ?? {};
}

async function call(ctx: ConnectorContext, method: string, path: string, query: Record<string, string> = {}, body?: unknown, form?: FormData) {
  await limiter.take(ctx.accountId);
  const cipher = ctx.credentials?.shopCipher;
  if (!cipher) permanent('NOT_CONNECTED', 'TikTok shop cipher missing. Reconnect the account.');
  return rawCall(await token(ctx), method, path, query, body, true, cipher, form);
}

export const TIKTOK_CAPABILITIES = (): Record<Operation, Capability> => {
  const m: Partial<Record<Operation, Capability>> = {
    CONNECT_ACCOUNT: { status: 'built', api: 'TikTok Shop app authorisation → token/get (auth code, refresh) + authorised shops (cipher)' },
    FETCH_CATEGORIES: { status: 'built', api: 'Product API get categories' },
    FETCH_CATEGORY_ATTRIBUTES: { status: 'built', api: 'Product API get attributes' },
    ADOPT_EXISTING_LISTINGS: { status: 'built', api: 'Product API search products' },
    CREATE_LISTING: { status: 'built', api: 'Product API upload image → create product', notes: 'Stays Publishing until TikTok’s audit approves it' },
    REVISE_LISTING: { status: 'built', api: 'Product API edit product' },
    UPDATE_PRICE_QUANTITY: { status: 'built', api: 'Product API update price / update inventory' },
    PAUSE_LISTING: { status: 'built', api: 'Product API deactivate / activate products' },
    END_LISTING: { status: 'built', api: 'Product API delete products' },
    GET_LISTING_STATUS: { status: 'built', api: 'Product API get product (status, audit failure reasons)' },
    FETCH_ORDERS: { status: 'built', api: 'Order API search orders' },
    PUSH_TRACKING: { status: 'built', api: 'Fulfillment API ship package (self shipment)', notes: 'Carrier → TikTok shipping provider ids set in account settings' },
    FETCH_RETURNS: { status: 'built', api: 'Finance API statement transactions (refunds)' },
    FETCH_FEES: { status: 'built', api: 'Finance API statement transactions' },
    FETCH_SETTLEMENTS: { status: 'built', api: 'Finance API statements (payment status)' },
  };
  return Object.fromEntries(OPERATIONS.map((o) => [o, m[o] ?? { status: 'planned' }])) as Record<Operation, Capability>;
};

export class TikTokConnector implements MarketplaceConnector {
  readonly marketplace = 'TIKTOK_UK' as const;
  readonly capabilities = TIKTOK_CAPABILITIES();

  private async uploadImages(ctx: ConnectorContext, images: Array<{ url: string }>) {
    const uris: Array<{ uri: string }> = [];
    for (const img of images.slice(0, 9)) {
      const file = await fetch(img.url);
      if (!file.ok) permanent('IMAGE_FETCH', `Could not read image ${img.url} for upload to TikTok.`);
      const form = new FormData();
      form.append('data', new Blob([await file.arrayBuffer()]), 'image.jpg');
      form.append('use_case', 'MAIN_IMAGE');
      const d = await call(ctx, 'POST', '/product/202309/images/upload', {}, undefined, form);
      uris.push({ uri: d.uri });
    }
    return uris;
  }

  private async productBody(ctx: ConnectorContext, p: PublishPayload, skuId?: string | null) {
    const c = p.content;
    const warehouseId = p.accountSettings.warehouseId ?? ctx.accountSettings.warehouseId;
    if (!warehouseId) permanent('ACCOUNT_SETTINGS', 'Set the TikTok warehouse ID in this account’s settings (Integrations page).');
    if (!c.categoryId) permanent('CATEGORY', 'Choose a TikTok category before publishing.');
    const attrs = await call(ctx, 'GET', `/product/202309/categories/${c.categoryId}/attributes`);
    const byName = new Map<string, any>((attrs.attributes ?? []).map((a: any) => [String(a.name).toLowerCase(), a]));
    const productAttributes = Object.entries((c.attributes ?? {}) as Record<string, string>)
      .map(([name, value]) => ({ a: byName.get(name.toLowerCase()), value }))
      .filter((x) => x.a && x.value && x.a.type !== 'SALES_PROPERTY')
      .map((x) => ({ id: x.a.id, values: [{ name: String(x.value) }] }));
    return {
      title: c.title,
      description: htmlDescription(c.description ?? ''),
      category_id: String(c.categoryId),
      main_images: await this.uploadImages(ctx, p.images),
      package_weight: { value: ((p.variant.weightGrams ?? 300) / 1000).toFixed(3), unit: 'KILOGRAM' },
      product_attributes: productAttributes,
      skus: [
        {
          ...(skuId ? { id: skuId } : {}),
          seller_sku: p.sku,
          price: { amount: money2(p.price), currency: 'GBP' },
          inventory: [{ warehouse_id: warehouseId, quantity: p.quantity }],
        },
      ],
    };
  }

  createListing(ctx: ConnectorContext, p: PublishPayload) {
    return attempt(async () => {
      const d = await call(ctx, 'POST', '/product/202309/products', {}, await this.productBody(ctx, p));
      return { externalListingId: String(d.product_id), externalOfferId: String(d.skus?.[0]?.id ?? ''), status: 'PENDING' as const };
    });
  }

  reviseListing(ctx: ConnectorContext, p: PublishPayload) {
    return attempt(async () => {
      await call(ctx, 'PUT', `/product/202309/products/${p.externalListingId}`, {}, await this.productBody(ctx, p, p.externalOfferId));
      return { status: 'PENDING' as const };
    });
  }

  updatePriceQuantity(ctx: ConnectorContext, p: { externalListingId: string; externalOfferId?: string | null; price?: string; quantity?: number }) {
    return attempt(async () => {
      if (!p.externalOfferId) permanent('SKU_ID', 'TikTok SKU id unknown; refresh the listing status first.');
      if (p.price !== undefined) await call(ctx, 'POST', `/product/202309/products/${p.externalListingId}/prices/update`, {}, { skus: [{ id: p.externalOfferId, price: { amount: money2(p.price), currency: 'GBP' } }] });
      if (p.quantity !== undefined) {
        const warehouseId = ctx.accountSettings.warehouseId;
        await call(ctx, 'POST', `/product/202309/products/${p.externalListingId}/inventory/update`, {}, { skus: [{ id: p.externalOfferId, inventory: [{ warehouse_id: warehouseId, quantity: p.quantity }] }] });
      }
      return { ok: true as const };
    });
  }

  setListingState(ctx: ConnectorContext, p: { externalListingId: string; state: 'PAUSED' | 'ENDED' | 'ACTIVE' }) {
    return attempt(async () => {
      if (p.state === 'ENDED') await call(ctx, 'DELETE', '/product/202309/products', {}, { product_ids: [p.externalListingId] });
      else await call(ctx, 'POST', `/product/202309/products/${p.state === 'PAUSED' ? 'deactivate' : 'activate'}`, {}, { product_ids: [p.externalListingId] });
      return { status: p.state };
    });
  }

  getListingStatus(ctx: ConnectorContext, p: { externalListingId: string }) {
    return attempt(async () => {
      const d = await call(ctx, 'GET', `/product/202309/products/${p.externalListingId}`);
      const reasons = (d.audit_failed_reasons ?? []).flatMap((r: any) => r.reasons ?? []).join('; ');
      const map: Record<string, 'ACTIVE' | 'PENDING' | 'FAILED' | 'ENDED' | 'PAUSED'> = {
        ACTIVATE: 'ACTIVE', PENDING: 'PENDING', DRAFT: 'PENDING', FAILED: 'FAILED', SELLER_DEACTIVATED: 'PAUSED', PLATFORM_DEACTIVATED: 'PAUSED', FREEZE: 'PAUSED', DELETED: 'ENDED',
      };
      return { state: map[d.status] ?? 'PENDING', reason: reasons || undefined, quantity: d.skus?.[0]?.inventory?.[0]?.quantity };
    });
  }

  fetchCategoryAttributes(ctx: ConnectorContext, categoryId: string) {
    return attempt(async () => {
      const d = await call(ctx, 'GET', `/product/202309/categories/${categoryId}/attributes`);
      const attrs = (d.attributes ?? []).filter((a: any) => a.type !== 'SALES_PROPERTY');
      const isReq = (a: any) => a.is_requried === true || a.is_required === true;
      return { required: attrs.filter(isReq).map((a: any) => a.name), optional: attrs.filter((a: any) => !isReq(a)).map((a: any) => a.name) };
    });
  }

  fetchOrders(ctx: ConnectorContext, since: Date) {
    return attempt(async () => {
      const orders: NormalizedOrder[] = [];
      let pageToken = '';
      do {
        const d = await call(ctx, 'POST', '/order/202309/orders/search', { page_size: '50', ...(pageToken ? { page_token: pageToken } : {}) }, { update_time_ge: Math.floor(since.getTime() / 1000) });
        for (const o of d.orders ?? []) orders.push(this.normaliseOrder(o));
        pageToken = d.next_page_token ?? '';
      } while (pageToken);
      return { orders };
    });
  }

  private normaliseOrder(o: any): NormalizedOrder {
    const map: Record<string, NormalizedOrder['status']> = {
      UNPAID: 'PENDING', ON_HOLD: 'AWAITING_DISPATCH', AWAITING_SHIPMENT: 'AWAITING_DISPATCH', PARTIALLY_SHIPPING: 'AWAITING_DISPATCH',
      AWAITING_COLLECTION: 'DISPATCHED', IN_TRANSIT: 'DISPATCHED', DELIVERED: 'DELIVERED', COMPLETED: 'DELIVERED', CANCELLED: 'CANCELLED',
    };
    const a = o.recipient_address ?? {};
    const shipping = Number(o.payment?.shipping_fee ?? 0);
    return {
      externalOrderId: String(o.id),
      status: map[o.status] ?? 'PENDING',
      orderedAt: new Date(Number(o.create_time) * 1000).toISOString(),
      dispatchBy: o.rts_sla_time ? new Date(Number(o.rts_sla_time) * 1000).toISOString() : null,
      deliveredAt: o.delivery_time ? new Date(Number(o.delivery_time) * 1000).toISOString() : null,
      currency: o.payment?.currency ?? 'GBP',
      pricesIncludeTax: true,
      taxCollectedByMarketplace: false,
      lines: (o.line_items ?? []).map((l: any, i: number) => ({
        externalLineId: String(l.id),
        sku: l.seller_sku,
        title: l.product_name,
        quantity: 1, // TikTok returns one line item per unit
        unitPrice: money2(l.original_price ?? l.sale_price ?? 0),
        shippingCharged: money2(i === 0 ? shipping : 0),
        sellerDiscount: money2(l.seller_discount ?? 0),
        taxAmount: null,
        externalListingId: l.product_id ? String(l.product_id) : null,
      })),
      customer: { name: a.name, email: o.buyer_email, phone: a.phone_number, line1: a.address_line1, line2: a.address_line2, city: a.address_line3 ?? a.city, region: a.address_line4, postcode: a.postal_code, country: a.region_code },
    };
  }

  pushTracking(ctx: ConnectorContext, p: { externalOrderId: string; carrier: string; trackingNumber: string }) {
    return attempt(async () => {
      const providerId = (ctx.accountSettings.shippingProviderIds ?? {})[p.carrier];
      if (!providerId) permanent('SHIPPING_PROVIDER', `Map the carrier "${p.carrier}" to a TikTok shipping provider id in this account’s settings.`);
      const d = await call(ctx, 'GET', '/order/202309/orders', { ids: p.externalOrderId });
      const packages = d.orders?.[0]?.packages ?? [];
      if (!packages.length) permanent('NO_PACKAGE', 'TikTok has no package for this order yet.');
      for (const pkg of packages) {
        await call(ctx, 'POST', `/fulfillment/202309/packages/${pkg.id}/ship`, {}, { handover_method: 'DROP_OFF', self_shipment: { tracking_number: p.trackingNumber, shipping_provider_id: providerId } });
      }
      return { ok: true as const };
    });
  }

  fetchFinancials(ctx: ConnectorContext, since: Date) {
    return attempt(async () => {
      const batch: FinancialBatch = { fees: [], refunds: [], settledOrders: [], cursor: null };
      const d = await call(ctx, 'GET', '/finance/202309/statements', { statement_time_ge: String(Math.floor(since.getTime() / 1000)), page_size: '100', sort_field: 'statement_time' });
      for (const st of d.statements ?? []) {
        const tx = await call(ctx, 'GET', `/finance/202309/statements/${st.id}/statement_transactions`, { page_size: '100' });
        const postedAt = new Date(Number(st.statement_time) * 1000).toISOString();
        for (const t of tx.statement_transactions ?? []) {
          const fees: Array<[string, string, string | undefined]> = [
            ['platform_commission_amount', 'final_value', 'Platform commission'],
            ['transaction_fee_amount', 'payment', 'Transaction fee'],
            ['affiliate_commission_amount', 'promoted', 'Affiliate commission'],
            ['shipping_fee_amount', 'fulfilment', 'Shipping fee'],
          ].map(([k, type, name]) => [type!, name!, t[k!]]);
          for (const [type, name, raw] of fees) {
            if (raw === undefined || Number(raw) === 0) continue;
            batch.fees.push({
              externalRef: `${st.id}:${t.id}:${type}`,
              externalOrderId: t.order_id ? String(t.order_id) : null,
              externalLineId: null,
              feeType: type,
              name,
              amount: money2(-Number(raw)), // TikTok reports deductions as negative
              currency: st.currency ?? 'GBP',
              postedAt,
              settlementId: String(st.id),
            });
          }
          if (t.type === 'REFUND' && t.order_id) {
            batch.refunds.push({
              externalRefundId: `${st.id}:${t.id}`,
              externalOrderId: String(t.order_id),
              externalLineId: null,
              amount: money2(Math.abs(Number(t.revenue_amount ?? 0))),
              taxAmount: null,
              currency: st.currency ?? 'GBP',
              refundedAt: postedAt,
            });
          }
          if (st.payment_status === 'PAID' && t.order_id && t.type === 'ORDER') {
            batch.settledOrders.push({ externalOrderId: String(t.order_id), settlementId: String(st.id), settledAt: postedAt });
          }
        }
      }
      return batch;
    });
  }

  fetchExistingListings(ctx: ConnectorContext) {
    return attempt(async () => {
      const listings: ExistingListing[] = [];
      let pageToken = '';
      do {
        const d = await call(ctx, 'POST', '/product/202309/products/search', { page_size: '100', ...(pageToken ? { page_token: pageToken } : {}) }, { status: 'ACTIVATE' });
        for (const prod of d.products ?? []) {
          for (const sku of prod.skus ?? []) {
            listings.push({
              externalListingId: String(prod.id),
              sku: sku.seller_sku,
              title: prod.title,
              price: String(sku.price?.tax_exclusive_price ?? sku.price?.sale_price ?? sku.price?.amount ?? '0'),
              currency: sku.price?.currency ?? 'GBP',
              quantity: Number(sku.inventory?.[0]?.quantity ?? 0),
              state: 'ACTIVE',
            });
          }
        }
        pageToken = d.next_page_token ?? '';
      } while (pageToken);
      return { listings };
    });
  }
}
