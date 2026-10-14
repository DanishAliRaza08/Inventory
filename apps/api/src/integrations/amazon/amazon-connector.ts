import { gunzipSync } from 'zlib';
import { appCredentials, config, endpoints } from '../../config';
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
import { attempt, money2, permanent } from '../util';

export const AMAZON_UK_MARKETPLACE_ID = 'A1F83G8C2ARO7P';
const limiter = new RateLimiter(1, 5);

export function amazonConsentUrl(state: string) {
  const q = new URLSearchParams({ application_id: appCredentials().amazon.appId, state, ...(config().NODE_ENV !== 'production' ? { version: 'beta' } : {}) });
  return `${endpoints().amazonConsent}?${q}`;
}

async function lwa(params: Record<string, string>) {
  const { clientId, clientSecret } = appCredentials().amazon;
  const r = ensureOk(
    await httpRequest({
      method: 'POST',
      url: endpoints().amazonToken,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, client_id: clientId, client_secret: clientSecret }).toString(),
    }),
    'Amazon LWA token',
  );
  return r.json as { access_token: string; refresh_token?: string; expires_in: number };
}

export async function amazonExchangeCode(code: string, sellingPartnerId: string) {
  const j = await lwa({ grant_type: 'authorization_code', code });
  return { refreshToken: j.refresh_token, accessToken: j.access_token, accessTokenExpiresAt: new Date(Date.now() + j.expires_in * 1000).toISOString(), sellerId: sellingPartnerId };
}

async function accessToken(ctx: ConnectorContext): Promise<string> {
  const c = ctx.credentials;
  if (!c?.refreshToken) permanent('NOT_CONNECTED', 'This Amazon account is not connected. Connect it on the Integrations page.');
  if (c.accessToken && new Date(c.accessTokenExpiresAt).getTime() - Date.now() > 60_000) return c.accessToken;
  const j = await lwa({ grant_type: 'refresh_token', refresh_token: c.refreshToken });
  const next = { ...c, accessToken: j.access_token, accessTokenExpiresAt: new Date(Date.now() + j.expires_in * 1000).toISOString() };
  await ctx.saveCredentials(next);
  ctx.credentials = next;
  return next.accessToken;
}

function sellerId(ctx: ConnectorContext): string {
  const id = ctx.credentials?.sellerId ?? ctx.accountSettings.sellerId;
  if (!id) permanent('ACCOUNT_SETTINGS', 'The Amazon seller (merchant) ID is missing. Reconnect the account.');
  return id;
}

async function sp(ctx: ConnectorContext, method: string, path: string, body?: unknown, tokenOverride?: string) {
  await limiter.take(`${ctx.accountId}:${path.split('/')[1]}`);
  const token = tokenOverride ?? (await accessToken(ctx));
  const res = await httpRequest({
    method,
    url: `${endpoints().amazonApi}${path}`,
    headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json', 'user-agent': 'FashionRockstarOps/1.0 (Language=TypeScript)' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return ensureOk(res, `Amazon ${method} ${path.split('?')[0]}`, (r) => r.json?.errors?.map((e: any) => e.message).join('; '));
}

const mp = (value: unknown, extra: Record<string, unknown> = {}) => [{ value, marketplace_id: AMAZON_UK_MARKETPLACE_ID, ...extra }];
const text = (value: string) => mp(value, { language_tag: 'en_GB' });
const ATTRIBUTE_NAMES: Record<string, string> = { colour: 'color', color: 'color', size: 'size', material: 'material', 'fabric type': 'fabric_type', style: 'style', pattern: 'pattern', 'department': 'department' };

function listingBody(p: PublishPayload) {
  const c = p.content;
  const productType = c.productType ?? p.accountSettings.defaultProductType;
  if (!productType) permanent('PRODUCT_TYPE', 'Choose the Amazon product type for this listing before publishing.');
  const attributes: Record<string, unknown> = {
    item_name: text(c.title),
    product_description: text(c.description ?? ''),
    bullet_point: (c.bulletPoints ?? []).map((b: string) => ({ value: b, language_tag: 'en_GB', marketplace_id: AMAZON_UK_MARKETPLACE_ID })),
    condition_type: mp(c.condition === 'USED' ? 'used_good' : 'new_new'),
    purchasable_offer: [{ currency: 'GBP', marketplace_id: AMAZON_UK_MARKETPLACE_ID, our_price: [{ schedule: [{ value_with_tax: Number(p.price) }] }] }],
    fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: p.quantity, lead_time_to_ship_max_days: c.dispatchTimeDays ?? 2 }],
  };
  if (c.brand) attributes.brand = mp(c.brand);
  if (c.gtin) attributes.externally_assigned_product_identifier = [{ type: String(c.gtin).length === 12 ? 'upc' : 'ean', value: c.gtin, marketplace_id: AMAZON_UK_MARKETPLACE_ID }];
  if (c.identifierExemption) attributes.supplier_declared_has_product_identifier_exemption = mp(true);
  if (c.searchKeywords?.length) attributes.generic_keyword = text(c.searchKeywords.join(' '));
  p.images.slice(0, 9).forEach((img, i) => {
    attributes[i === 0 ? 'main_product_image_locator' : `other_product_image_locator_${i}`] = [{ media_location: img.url, marketplace_id: AMAZON_UK_MARKETPLACE_ID }];
  });
  for (const [name, v] of Object.entries((c.attributes ?? {}) as Record<string, string>)) {
    const key = ATTRIBUTE_NAMES[name.toLowerCase()] ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    if (!attributes[key] && v) attributes[key] = mp(v);
  }
  return { productType, requirements: 'LISTING', attributes };
}

function issuesText(issues: any[] | undefined) {
  return (issues ?? []).filter((i) => i.severity === 'ERROR').map((i) => `${i.code}: ${i.message}`).join('; ');
}

async function report(ctx: ConnectorContext, reportType: string): Promise<string> {
  const created = await sp(ctx, 'POST', '/reports/2021-06-30/reports', { reportType, marketplaceIds: [AMAZON_UK_MARKETPLACE_ID] });
  const id = created.json.reportId;
  for (let i = 0; i < 40; i++) {
    const r = await sp(ctx, 'GET', `/reports/2021-06-30/reports/${id}`);
    if (r.json.processingStatus === 'DONE') return downloadDocument(ctx, r.json.reportDocumentId);
    if (['CANCELLED', 'FATAL'].includes(r.json.processingStatus)) permanent('REPORT_FAILED', `Amazon could not produce the ${reportType} report.`);
    await new Promise((res) => setTimeout(res, config().MOCK_MARKETPLACES ? 50 : 15_000));
  }
  throw new ApiCallError('Amazon report still processing', { transient: true, code: 'REPORT_PENDING', readable: 'Amazon is still preparing the report; it will be retried.' });
}

async function downloadDocument(ctx: ConnectorContext, documentId: string): Promise<string> {
  const doc = await sp(ctx, 'GET', `/reports/2021-06-30/documents/${documentId}`);
  const res = await fetch(doc.json.url);
  const buf = Buffer.from(await res.arrayBuffer());
  return (doc.json.compressionAlgorithm === 'GZIP' ? gunzipSync(buf) : buf).toString('utf8');
}

function parseTsv(tsv: string): Array<Record<string, string>> {
  const [head, ...lines] = tsv.trim().split(/\r?\n/);
  const cols = (head ?? '').split('\t');
  return lines.filter(Boolean).map((l) => Object.fromEntries(l.split('\t').map((v, i) => [cols[i], v])));
}

export const AMAZON_CAPABILITIES = (): Record<Operation, Capability> => {
  const m: Partial<Record<Operation, Capability>> = {
    CONNECT_ACCOUNT: { status: 'built', api: 'Seller Central consent → LWA authorization code / refresh token (or a self-authorised refresh token)' },
    FETCH_CATEGORIES: { status: 'built', api: 'Product Type Definitions API' },
    FETCH_CATEGORY_ATTRIBUTES: { status: 'built', api: 'Product Type Definitions API getDefinitionsProductType (required properties of the JSON schema)' },
    ADOPT_EXISTING_LISTINGS: { status: 'built', api: 'Reports API GET_MERCHANT_LISTINGS_ALL_DATA' },
    CREATE_LISTING: { status: 'built', api: 'Listings Items API putListingsItem', notes: 'ACCEPTED submissions stay Publishing until getListingsItem reports BUYABLE' },
    REVISE_LISTING: { status: 'built', api: 'Listings Items API putListingsItem' },
    UPDATE_PRICE_QUANTITY: { status: 'built', api: 'Listings Items API patchListingsItem' },
    PAUSE_LISTING: { status: 'built', api: 'patchListingsItem fulfillment_availability quantity 0' },
    END_LISTING: { status: 'built', api: 'Listings Items API deleteListingsItem' },
    GET_LISTING_STATUS: { status: 'built', api: 'Listings Items API getListingsItem (summaries, issues)' },
    FETCH_ORDERS: { status: 'built', api: 'Orders API getOrders + getOrderItems with a Restricted Data Token for buyer address', notes: 'Merchant-fulfilled orders; needs the restricted Direct-to-Consumer Shipping role' },
    PUSH_TRACKING: { status: 'built', api: 'Orders API confirmShipment' },
    FETCH_RETURNS: { status: 'built', api: 'Finances API RefundEventList' },
    FETCH_FEES: { status: 'built', api: 'Finances API listFinancialEvents' },
    FETCH_SETTLEMENTS: { status: 'built', api: 'Reports API GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2' },
  };
  return Object.fromEntries(OPERATIONS.map((o) => [o, m[o] ?? { status: 'planned' }])) as Record<Operation, Capability>;
};

export class AmazonConnector implements MarketplaceConnector {
  readonly marketplace = 'AMAZON_UK' as const;
  readonly capabilities = AMAZON_CAPABILITIES();

  createListing(ctx: ConnectorContext, p: PublishPayload) {
    return attempt(async () => {
      const r = await sp(ctx, 'PUT', `/listings/2021-08-01/items/${sellerId(ctx)}/${encodeURIComponent(p.sku)}?marketplaceIds=${AMAZON_UK_MARKETPLACE_ID}&issueLocale=en_GB`, listingBody(p));
      if (r.json.status !== 'ACCEPTED') permanent('AMAZON_INVALID', `Amazon rejected the listing: ${issuesText(r.json.issues) || r.json.status}`);
      // Accepted for processing: the listing is confirmed only when Amazon reports it buyable.
      return { externalListingId: p.sku, externalOfferId: r.json.submissionId, status: 'PENDING' as const };
    });
  }

  reviseListing(ctx: ConnectorContext, p: PublishPayload) {
    return attempt(async () => {
      const r = await sp(ctx, 'PUT', `/listings/2021-08-01/items/${sellerId(ctx)}/${encodeURIComponent(p.sku)}?marketplaceIds=${AMAZON_UK_MARKETPLACE_ID}&issueLocale=en_GB`, listingBody(p));
      if (r.json.status !== 'ACCEPTED') permanent('AMAZON_INVALID', `Amazon rejected the update: ${issuesText(r.json.issues) || r.json.status}`);
      return { status: 'PENDING' as const };
    });
  }

  private async productType(ctx: ConnectorContext, sku: string) {
    const r = await sp(ctx, 'GET', `/listings/2021-08-01/items/${sellerId(ctx)}/${encodeURIComponent(sku)}?marketplaceIds=${AMAZON_UK_MARKETPLACE_ID}&includedData=summaries`);
    return r.json.summaries?.[0]?.productType as string;
  }

  private patch(ctx: ConnectorContext, sku: string, productType: string, patches: unknown[]) {
    return sp(ctx, 'PATCH', `/listings/2021-08-01/items/${sellerId(ctx)}/${encodeURIComponent(sku)}?marketplaceIds=${AMAZON_UK_MARKETPLACE_ID}`, { productType, patches });
  }

  updatePriceQuantity(ctx: ConnectorContext, p: { sku: string; price?: string; quantity?: number }) {
    return attempt(async () => {
      const patches: unknown[] = [];
      if (p.price !== undefined) patches.push({ op: 'replace', path: '/attributes/purchasable_offer', value: [{ currency: 'GBP', marketplace_id: AMAZON_UK_MARKETPLACE_ID, our_price: [{ schedule: [{ value_with_tax: Number(p.price) }] }] }] });
      if (p.quantity !== undefined) patches.push({ op: 'replace', path: '/attributes/fulfillment_availability', value: [{ fulfillment_channel_code: 'DEFAULT', quantity: p.quantity }] });
      await this.patch(ctx, p.sku, await this.productType(ctx, p.sku), patches);
      return { ok: true as const };
    });
  }

  setListingState(ctx: ConnectorContext, p: { sku: string; state: 'PAUSED' | 'ENDED' | 'ACTIVE'; quantity?: number }) {
    return attempt(async () => {
      if (p.state === 'ENDED') {
        await sp(ctx, 'DELETE', `/listings/2021-08-01/items/${sellerId(ctx)}/${encodeURIComponent(p.sku)}?marketplaceIds=${AMAZON_UK_MARKETPLACE_ID}`);
      } else {
        const quantity = p.state === 'PAUSED' ? 0 : Math.max(1, p.quantity ?? 1);
        await this.patch(ctx, p.sku, await this.productType(ctx, p.sku), [{ op: 'replace', path: '/attributes/fulfillment_availability', value: [{ fulfillment_channel_code: 'DEFAULT', quantity }] }]);
      }
      return { status: p.state };
    });
  }

  getListingStatus(ctx: ConnectorContext, p: { sku: string }) {
    return attempt(async () => {
      const res = await httpRequest({
        method: 'GET',
        url: `${endpoints().amazonApi}/listings/2021-08-01/items/${sellerId(ctx)}/${encodeURIComponent(p.sku)}?marketplaceIds=${AMAZON_UK_MARKETPLACE_ID}&includedData=summaries,issues,fulfillmentAvailability`,
        headers: { 'x-amz-access-token': await accessToken(ctx) },
      });
      if (res.status === 404) return { state: 'PENDING' as const, reason: 'Amazon is still processing the submission' };
      ensureOk(res, 'Amazon getListingsItem');
      const errors = issuesText(res.json.issues);
      const status: string[] = res.json.summaries?.[0]?.status ?? [];
      const qty = res.json.fulfillmentAvailability?.[0]?.quantity;
      if (status.includes('BUYABLE')) return { state: qty === 0 ? ('PAUSED' as const) : ('ACTIVE' as const), quantity: qty };
      if (errors) return { state: 'FAILED' as const, reason: errors };
      return { state: 'PENDING' as const, reason: 'Not yet buyable on Amazon' };
    });
  }

  fetchCategoryAttributes(ctx: ConnectorContext, productType: string) {
    return attempt(async () => {
      const def = await sp(ctx, 'GET', `/definitions/2020-09-01/productTypes/${encodeURIComponent(productType)}?marketplaceIds=${AMAZON_UK_MARKETPLACE_ID}&requirements=LISTING&locale=en_GB`);
      const schemaRes = ensureOk(await httpRequest({ method: 'GET', url: def.json.schema.link.resource }), 'Amazon product type schema');
      const schema = schemaRes.json ?? JSON.parse(schemaRes.text);
      const required: string[] = schema.required ?? [];
      return { required, optional: Object.keys(schema.properties ?? {}).filter((k) => !required.includes(k)) };
    });
  }

  fetchOrders(ctx: ConnectorContext, since: Date) {
    return attempt(async () => {
      // A Restricted Data Token unlocks buyer name/address (requires the Direct-to-Consumer Shipping role).
      let rdt: string | undefined;
      try {
        const t = await sp(ctx, 'POST', '/tokens/2021-03-01/restrictedDataToken', {
          restrictedResources: [{ method: 'GET', path: '/orders/v0/orders', dataElements: ['buyerInfo', 'shippingAddress'] }],
        });
        rdt = t.json.restrictedDataToken;
      } catch {
        rdt = undefined; // role not granted: orders import without customer details
      }
      const orders: NormalizedOrder[] = [];
      let next: string | undefined;
      do {
        const q = next
          ? `NextToken=${encodeURIComponent(next)}&MarketplaceIds=${AMAZON_UK_MARKETPLACE_ID}`
          : `MarketplaceIds=${AMAZON_UK_MARKETPLACE_ID}&LastUpdatedAfter=${encodeURIComponent(since.toISOString())}&FulfillmentChannels=MFN&MaxResultsPerPage=100`;
        const r = await sp(ctx, 'GET', `/orders/v0/orders?${q}`, undefined, rdt);
        for (const o of r.json.payload?.Orders ?? []) {
          const items = await sp(ctx, 'GET', `/orders/v0/orders/${o.AmazonOrderId}/orderItems`);
          orders.push(this.normaliseOrder(o, items.json.payload?.OrderItems ?? []));
        }
        next = r.json.payload?.NextToken;
      } while (next);
      return { orders };
    });
  }

  private normaliseOrder(o: any, items: any[]): NormalizedOrder {
    const map: Record<string, NormalizedOrder['status']> = { Pending: 'PENDING', Unshipped: 'AWAITING_DISPATCH', PartiallyShipped: 'AWAITING_DISPATCH', Shipped: 'DISPATCHED', Canceled: 'CANCELLED', Unfulfillable: 'CANCELLED' };
    const a = o.ShippingAddress;
    return {
      externalOrderId: o.AmazonOrderId,
      status: map[o.OrderStatus] ?? 'PENDING',
      orderedAt: o.PurchaseDate,
      dispatchBy: o.LatestShipDate ?? null,
      currency: o.OrderTotal?.CurrencyCode ?? 'GBP',
      pricesIncludeTax: true,
      taxCollectedByMarketplace: !!o.IsIossOrder || items.some((i) => i.TaxCollection?.Model === 'MarketplaceFacilitator'),
      lines: items.map((i) => {
        const qty = Number(i.QuantityOrdered ?? 1) || 1;
        return {
          externalLineId: i.OrderItemId,
          sku: i.SellerSKU,
          title: i.Title,
          quantity: qty,
          unitPrice: money2(Number(i.ItemPrice?.Amount ?? 0) / qty),
          shippingCharged: money2(i.ShippingPrice?.Amount ?? 0),
          sellerDiscount: money2(Number(i.PromotionDiscount?.Amount ?? 0) + Number(i.ShippingDiscount?.Amount ?? 0)),
          taxAmount: i.ItemTax ? money2(Number(i.ItemTax.Amount ?? 0) + Number(i.ShippingTax?.Amount ?? 0)) : null,
          externalListingId: i.SellerSKU,
        };
      }),
      customer: a
        ? { name: a.Name ?? o.BuyerInfo?.BuyerName, email: o.BuyerInfo?.BuyerEmail, phone: a.Phone, line1: a.AddressLine1, line2: a.AddressLine2, city: a.City, region: a.StateOrRegion, postcode: a.PostalCode, country: a.CountryCode }
        : null,
    };
  }

  pushTracking(ctx: ConnectorContext, p: { externalOrderId: string; lines: Array<{ externalLineId: string; quantity: number }>; carrier: string; trackingNumber: string; shippedAt: Date }) {
    return attempt(async () => {
      await sp(ctx, 'POST', `/orders/v0/orders/${p.externalOrderId}/shipmentConfirmation`, {
        marketplaceId: AMAZON_UK_MARKETPLACE_ID,
        packageDetail: {
          packageReferenceId: '1',
          carrierCode: p.carrier,
          trackingNumber: p.trackingNumber,
          shipDate: p.shippedAt.toISOString(),
          orderItems: p.lines.map((l) => ({ orderItemId: l.externalLineId, quantity: l.quantity })),
        },
      });
      return { ok: true as const };
    });
  }

  fetchFinancials(ctx: ConnectorContext, since: Date) {
    return attempt(async () => {
      const batch: FinancialBatch = { fees: [], refunds: [], settledOrders: [], cursor: null };
      const feeType = (t: string) => (/Commission|Referral/i.test(t) ? 'final_value' : /FBA|Fulfil/i.test(t) ? 'fulfilment' : /DigitalServices/i.test(t) ? 'regulatory' : 'other');
      let next: string | undefined;
      do {
        const q = next ? `NextToken=${encodeURIComponent(next)}` : `PostedAfter=${encodeURIComponent(since.toISOString())}&MaxResultsPerPage=100`;
        const r = await sp(ctx, 'GET', `/finances/v0/financialEvents?${q}`);
        const ev = r.json.payload?.FinancialEvents ?? {};
        for (const s of ev.ShipmentEventList ?? []) {
          for (const item of s.ShipmentItemList ?? []) {
            for (const f of item.ItemFeeList ?? []) {
              batch.fees.push({
                externalRef: `${s.AmazonOrderId}:${item.OrderItemId}:${f.FeeType}:${s.PostedDate}`,
                externalOrderId: s.AmazonOrderId,
                externalLineId: item.OrderItemId,
                feeType: feeType(f.FeeType),
                name: f.FeeType,
                // Amazon reports charges as negative amounts; the platform stores charges as positive.
                amount: money2(-Number(f.FeeAmount?.CurrencyAmount ?? 0)),
                currency: f.FeeAmount?.CurrencyCode ?? 'GBP',
                postedAt: s.PostedDate,
              });
            }
          }
        }
        for (const rf of ev.RefundEventList ?? []) {
          for (const item of rf.ShipmentItemAdjustmentList ?? []) {
            const charges = item.ItemChargeAdjustmentList ?? [];
            const principal = charges.filter((c: any) => c.ChargeType !== 'Tax').reduce((a: number, c: any) => a + Number(c.ChargeAmount?.CurrencyAmount ?? 0), 0);
            const tax = charges.filter((c: any) => c.ChargeType === 'Tax').reduce((a: number, c: any) => a + Number(c.ChargeAmount?.CurrencyAmount ?? 0), 0);
            batch.refunds.push({
              externalRefundId: `${rf.AmazonOrderId}:${item.OrderAdjustmentItemId ?? item.OrderItemId}:${rf.PostedDate}`,
              externalOrderId: rf.AmazonOrderId,
              externalLineId: item.OrderItemId ?? null,
              amount: money2(-(principal + tax)),
              taxAmount: money2(-tax),
              currency: charges[0]?.ChargeAmount?.CurrencyCode ?? 'GBP',
              refundedAt: rf.PostedDate,
            });
            for (const f of item.ItemFeeAdjustmentList ?? []) {
              batch.fees.push({
                externalRef: `refund:${rf.AmazonOrderId}:${item.OrderItemId}:${f.FeeType}:${rf.PostedDate}`,
                externalOrderId: rf.AmazonOrderId,
                externalLineId: item.OrderItemId ?? null,
                feeType: feeType(f.FeeType),
                name: `${f.FeeType} (refund credit)`,
                amount: money2(-Number(f.FeeAmount?.CurrencyAmount ?? 0)),
                currency: f.FeeAmount?.CurrencyCode ?? 'GBP',
                postedAt: rf.PostedDate,
              });
            }
          }
        }
        next = r.json.payload?.NextToken;
      } while (next);

      // Settlement reports are generated by Amazon every ~14 days.
      const reports = await sp(ctx, 'GET', `/reports/2021-06-30/reports?reportTypes=GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2&createdSince=${encodeURIComponent(since.toISOString())}`);
      for (const rep of reports.json.reports ?? []) {
        if (rep.processingStatus !== 'DONE') continue;
        const rows = parseTsv(await downloadDocument(ctx, rep.reportDocumentId));
        const seen = new Set<string>();
        for (const row of rows) {
          const orderId = row['order-id'];
          if (orderId && !seen.has(orderId)) {
            seen.add(orderId);
            batch.settledOrders.push({ externalOrderId: orderId, settlementId: row['settlement-id'] ?? rep.reportId, settledAt: row['posted-date'] || rep.dataEndTime });
          }
        }
      }
      return batch;
    });
  }

  fetchExistingListings(ctx: ConnectorContext) {
    return attempt(async () => {
      const rows = parseTsv(await report(ctx, 'GET_MERCHANT_LISTINGS_ALL_DATA'));
      const listings: ExistingListing[] = rows.map((r) => ({
        externalListingId: r['seller-sku'],
        sku: r['seller-sku'],
        title: r['item-name'] ?? '',
        price: r['price'] ?? '0',
        currency: 'GBP',
        quantity: Number(r['quantity'] ?? 0),
        state: (r['status'] ?? '').toLowerCase() === 'active' ? 'ACTIVE' : 'PAUSED',
      }));
      return { listings };
    });
  }
}
