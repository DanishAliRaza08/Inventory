import { MarketplaceCode } from '@fr/core';
import { endpoints } from '../../config';
import { ensureOk, httpRequest } from '../http';
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
import { asArray, attempt, htmlDescription, money2, permanent } from '../util';
import { ebayAppToken, ebayUserToken } from './ebay-auth';
import { ebaySignatureHeaders } from './ebay-signature';
import { tradingCall } from './trading';

const CONDITION_IDS: Record<string, string> = { NEW: '1000', NEW_OTHER: '1500', NEW_WITH_DEFECTS: '1750', USED: '3000' };
const TREE_IDS: Record<string, string> = { EBAY_UK: '3', EBAY_US: '0' };

export const EBAY_CAPABILITIES = (): Record<Operation, Capability> => {
  const m: Partial<Record<Operation, Capability>> = {
    CONNECT_ACCOUNT: { status: 'built', api: 'OAuth 2.0 authorization code grant + refresh token (accepted by the Trading API via X-EBAY-API-IAF-TOKEN)' },
    FETCH_CATEGORIES: { status: 'built', api: 'Commerce Taxonomy API (category tree 3 = UK, 0 = US)' },
    FETCH_CATEGORY_ATTRIBUTES: { status: 'built', api: 'Taxonomy API getItemAspectsForCategory' },
    ADOPT_EXISTING_LISTINGS: { status: 'built', api: 'Trading API GetMyeBaySelling (ActiveList)', notes: 'Existing Seller Hub listings are linked by Custom Label (SKU); no migration' },
    CREATE_LISTING: { status: 'built', api: 'Trading API VerifyAddFixedPriceItem → AddFixedPriceItem' },
    REVISE_LISTING: { status: 'built', api: 'Trading API ReviseFixedPriceItem' },
    UPDATE_PRICE_QUANTITY: { status: 'built', api: 'Trading API ReviseInventoryStatus' },
    PAUSE_LISTING: { status: 'built', api: 'ReviseInventoryStatus quantity 0 (out-of-stock control)', notes: 'eBay fixed-price listings have no paused state' },
    END_LISTING: { status: 'built', api: 'Trading API EndFixedPriceItem' },
    GET_LISTING_STATUS: { status: 'built', api: 'Trading API GetItem' },
    FETCH_ORDERS: { status: 'built', api: 'Sell Fulfillment API getOrders' },
    PUSH_TRACKING: { status: 'built', api: 'Sell Fulfillment API createShippingFulfillment' },
    FETCH_RETURNS: { status: 'built', api: 'Finances API REFUND transactions', notes: 'Return cases themselves are handled in Seller Hub' },
    FETCH_FEES: { status: 'built', api: 'Sell Finances API getTransactions (digital signatures for UK/EU sellers)' },
    FETCH_SETTLEMENTS: { status: 'built', api: 'Sell Finances API getTransactions (payout status)' },
  };
  return Object.fromEntries(OPERATIONS.map((o) => [o, m[o] ?? { status: 'planned' }])) as Record<Operation, Capability>;
};

export class EbayConnector implements MarketplaceConnector {
  readonly capabilities = EBAY_CAPABILITIES();
  constructor(readonly marketplace: 'EBAY_UK' | 'EBAY_US') {}

  private get site() {
    return this.marketplace;
  }

  private itemXml(ctx: ConnectorContext, p: PublishPayload) {
    const c = p.content;
    const s = { ...ctx.accountSettings, ...p.accountSettings };
    if (!s.postcode) permanent('ACCOUNT_SETTINGS', 'Set the item location postcode in this eBay account’s settings (Integrations page).');
    const specifics = Object.entries((c.attributes ?? {}) as Record<string, string | string[]>)
      .filter(([, v]) => (Array.isArray(v) ? v.length : String(v ?? '').trim()))
      .map(([Name, v]) => ({ Name, Value: Array.isArray(v) ? v : [String(v)] }));
    const gtin = c.gtin ? (String(c.gtin).length === 12 ? { UPC: c.gtin } : { EAN: c.gtin }) : this.marketplace === 'EBAY_UK' ? { EAN: 'Does not apply' } : { UPC: 'Does not apply' };
    return {
      SKU: p.sku,
      Title: c.title,
      Description: { __cdata: htmlDescription(c.description ?? '') },
      PrimaryCategory: { CategoryID: c.categoryId },
      StartPrice: { '#text': money2(p.price), '@_currencyID': p.currency },
      ConditionID: CONDITION_IDS[c.condition ?? 'NEW'] ?? '1000',
      Country: s.country ?? (this.marketplace === 'EBAY_UK' ? 'GB' : 'US'),
      Currency: p.currency,
      PostalCode: s.postcode,
      Location: s.location ?? undefined,
      DispatchTimeMax: c.dispatchTimeDays ?? 3,
      ListingDuration: 'GTC',
      ListingType: 'FixedPriceItem',
      Quantity: p.quantity,
      Site: this.marketplace === 'EBAY_UK' ? 'UK' : 'US',
      PictureDetails: { PictureURL: p.images.map((i) => i.url) },
      ItemSpecifics: specifics.length ? { NameValueList: specifics } : undefined,
      ProductListingDetails: gtin,
      SellerProfiles: {
        SellerShippingProfile: { ShippingProfileID: c.shippingPolicyId },
        SellerReturnProfile: { ReturnProfileID: c.returnPolicyId },
        SellerPaymentProfile: { PaymentProfileID: c.paymentPolicyId ?? s.paymentPolicyId },
      },
    };
  }

  createListing(ctx: ConnectorContext, p: PublishPayload) {
    return attempt(async () => {
      const token = await ebayUserToken(ctx);
      const Item = this.itemXml(ctx, p);
      // Verify first: catches policy/category problems without creating anything.
      await tradingCall('VerifyAddFixedPriceItem', this.site, token, { Item }, ctx.accountId);
      const r = await tradingCall('AddFixedPriceItem', this.site, token, { Item }, ctx.accountId);
      return { externalListingId: String(r.ItemID), status: 'ACTIVE' as const };
    });
  }

  reviseListing(ctx: ConnectorContext, p: PublishPayload) {
    return attempt(async () => {
      const token = await ebayUserToken(ctx);
      await tradingCall('ReviseFixedPriceItem', this.site, token, { Item: { ItemID: p.externalListingId, ...this.itemXml(ctx, p) } }, ctx.accountId);
      return { status: 'ACTIVE' as const };
    });
  }

  updatePriceQuantity(ctx: ConnectorContext, p: { externalListingId: string; sku: string; price?: string; quantity?: number; currency: string }) {
    return attempt(async () => {
      const token = await ebayUserToken(ctx);
      const status: Record<string, unknown> = { ItemID: p.externalListingId };
      if (p.price !== undefined) status.StartPrice = money2(p.price);
      if (p.quantity !== undefined) status.Quantity = p.quantity;
      await tradingCall('ReviseInventoryStatus', this.site, token, { InventoryStatus: [status] }, ctx.accountId);
      return { ok: true as const };
    });
  }

  setListingState(ctx: ConnectorContext, p: { externalListingId: string; sku: string; state: 'PAUSED' | 'ENDED' | 'ACTIVE'; quantity?: number }) {
    return attempt(async () => {
      const token = await ebayUserToken(ctx);
      if (p.state === 'ENDED') {
        await tradingCall('EndFixedPriceItem', this.site, token, { ItemID: p.externalListingId, EndingReason: 'NotAvailable' }, ctx.accountId);
      } else {
        const q = p.state === 'PAUSED' ? 0 : Math.max(1, p.quantity ?? 1);
        await tradingCall('ReviseInventoryStatus', this.site, token, { InventoryStatus: [{ ItemID: p.externalListingId, Quantity: q }] }, ctx.accountId);
      }
      return { status: p.state };
    });
  }

  getListingStatus(ctx: ConnectorContext, p: { externalListingId: string }) {
    return attempt(async () => {
      const token = await ebayUserToken(ctx);
      const r = await tradingCall('GetItem', this.site, token, { ItemID: p.externalListingId }, ctx.accountId);
      const item = asArray(r.Item)[0] ?? {};
      const listingStatus = item.SellingStatus?.ListingStatus;
      const qty = Number(item.Quantity ?? 0) - Number(item.SellingStatus?.QuantitySold ?? 0);
      return {
        state: listingStatus === 'Active' ? (qty > 0 ? ('ACTIVE' as const) : ('PAUSED' as const)) : ('ENDED' as const),
        quantity: qty,
        price: item.StartPrice?.['#text'] ?? item.StartPrice,
      };
    });
  }

  fetchCategoryAttributes(_ctx: ConnectorContext, categoryId: string) {
    return attempt(async () => {
      const token = await ebayAppToken();
      const url = `${endpoints().ebayApi}/commerce/taxonomy/v1/category_tree/${TREE_IDS[this.marketplace]}/get_item_aspects_for_category?category_id=${encodeURIComponent(categoryId)}`;
      const r = ensureOk(await httpRequest({ method: 'GET', url, headers: { Authorization: `Bearer ${token}` } }), 'eBay getItemAspectsForCategory');
      const aspects = (r.json?.aspects ?? []) as Array<{ localizedAspectName: string; aspectConstraint?: { aspectRequired?: boolean } }>;
      return {
        required: aspects.filter((a) => a.aspectConstraint?.aspectRequired).map((a) => a.localizedAspectName),
        optional: aspects.filter((a) => !a.aspectConstraint?.aspectRequired).map((a) => a.localizedAspectName),
      };
    });
  }

  fetchOrders(ctx: ConnectorContext, since: Date) {
    return attempt(async () => {
      const token = await ebayUserToken(ctx);
      const orders: NormalizedOrder[] = [];
      let url: string | null =
        `${endpoints().ebayApi}/sell/fulfillment/v1/order?limit=100&filter=${encodeURIComponent(`lastmodifieddate:[${since.toISOString()}..]`)}`;
      while (url) {
        const r = ensureOk(await httpRequest({ method: 'GET', url, headers: { Authorization: `Bearer ${token}` } }), 'eBay getOrders');
        const site = this.marketplace === 'EBAY_UK' ? 'EBAY_GB' : 'EBAY_US';
        // A seller account can sell on several eBay sites; keep only this site's orders.
        for (const o of r.json?.orders ?? []) {
          const listedOn = o.lineItems?.[0]?.listingMarketplaceId;
          if (!listedOn || listedOn === site) orders.push(this.normaliseOrder(o));
        }
        url = r.json?.next ?? null;
      }
      return { orders };
    });
  }

  private normaliseOrder(o: any): NormalizedOrder {
    const shipTo = o.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo;
    const cancelled = o.cancelStatus?.cancelState === 'CANCELED';
    const status = cancelled
      ? 'CANCELLED'
      : o.orderFulfillmentStatus === 'FULFILLED'
        ? 'DISPATCHED'
        : o.orderPaymentStatus === 'PAID' || o.orderPaymentStatus === 'FULLY_REFUNDED'
          ? 'AWAITING_DISPATCH'
          : 'PENDING';
    const anyRemitted = (o.lineItems ?? []).some((l: any) => (l.ebayCollectAndRemitTaxes ?? []).length > 0);
    return {
      externalOrderId: o.orderId,
      status,
      orderedAt: o.creationDate,
      dispatchBy: o.lineItems?.[0]?.lineItemFulfillmentInstructions?.shipByDate ?? null,
      currency: o.pricingSummary?.total?.currency ?? (this.marketplace === 'EBAY_UK' ? 'GBP' : 'USD'),
      // UK prices include VAT; US sales tax is added on top and remitted by eBay.
      pricesIncludeTax: this.marketplace === 'EBAY_UK',
      taxCollectedByMarketplace: this.marketplace === 'EBAY_US' || anyRemitted,
      lines: (o.lineItems ?? []).map((l: any) => {
        const qty = Number(l.quantity ?? 1);
        const discount = (l.appliedPromotions ?? []).reduce((a: number, p: any) => a + Number(p.discountAmount?.value ?? 0), 0);
        const tax = (l.ebayCollectAndRemitTaxes ?? []).reduce((a: number, t: any) => a + Number(t.amount?.value ?? 0), 0);
        return {
          externalLineId: l.lineItemId,
          sku: l.sku ?? l.legacyItemId,
          title: l.title,
          quantity: qty,
          unitPrice: money2(Number(l.lineItemCost?.value ?? 0) / qty),
          shippingCharged: money2(l.deliveryCost?.shippingCost?.value ?? 0),
          sellerDiscount: money2(discount),
          taxAmount: tax ? money2(tax) : null,
          externalListingId: l.legacyItemId ?? null,
        };
      }),
      customer: shipTo
        ? {
            name: shipTo.fullName,
            email: shipTo.email,
            phone: shipTo.primaryPhone?.phoneNumber,
            line1: shipTo.contactAddress?.addressLine1,
            line2: shipTo.contactAddress?.addressLine2,
            city: shipTo.contactAddress?.city,
            region: shipTo.contactAddress?.stateOrProvince,
            postcode: shipTo.contactAddress?.postalCode,
            country: shipTo.contactAddress?.countryCode,
          }
        : null,
    };
  }

  pushTracking(ctx: ConnectorContext, p: { externalOrderId: string; lines: Array<{ externalLineId: string; quantity: number }>; carrier: string; trackingNumber: string; shippedAt: Date }) {
    return attempt(async () => {
      const token = await ebayUserToken(ctx);
      ensureOk(
        await httpRequest({
          method: 'POST',
          url: `${endpoints().ebayApi}/sell/fulfillment/v1/order/${encodeURIComponent(p.externalOrderId)}/shipping_fulfillment`,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lineItems: p.lines.map((l) => ({ lineItemId: l.externalLineId, quantity: l.quantity })),
            shippedDate: p.shippedAt.toISOString(),
            shippingCarrierCode: p.carrier,
            trackingNumber: p.trackingNumber,
          }),
        }),
        'eBay createShippingFulfillment',
      );
      return { ok: true as const };
    });
  }

  fetchFinancials(ctx: ConnectorContext, since: Date) {
    return attempt(async () => {
      const token = await ebayUserToken(ctx);
      const batch: FinancialBatch = { fees: [], refunds: [], settledOrders: [], cursor: null };
      let offset = 0;
      for (;;) {
        const url = `${endpoints().ebayApiz}/sell/finances/v1/transaction?limit=200&offset=${offset}&filter=${encodeURIComponent(`transactionDate:[${since.toISOString()}..]`)}`;
        const marketplaceId = this.marketplace === 'EBAY_UK' ? 'EBAY_GB' : 'EBAY_US';
        const r = ensureOk(
          await httpRequest({ method: 'GET', url, headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': marketplaceId, ...ebaySignatureHeaders('GET', url) } }),
          'eBay getTransactions',
        );
        const txs = r.json?.transactions ?? [];
        for (const t of txs) {
          if (t.transactionType === 'SALE') {
            for (const li of t.orderLineItems ?? []) {
              for (const f of li.marketplaceFees ?? []) {
                batch.fees.push({
                  externalRef: `${t.transactionId}:${li.lineItemId}:${f.feeType}`,
                  externalOrderId: t.orderId,
                  externalLineId: li.lineItemId,
                  feeType: /AD_FEE|PROMOTED/i.test(f.feeType) ? 'promoted' : /PAYMENT|PROCESSING/i.test(f.feeType) ? 'payment' : /REGULATORY/i.test(f.feeType) ? 'regulatory' : 'final_value',
                  name: f.feeType,
                  amount: money2(f.amount?.value ?? 0),
                  currency: f.amount?.currency,
                  postedAt: t.transactionDate,
                  settlementId: t.payoutId ?? null,
                });
              }
            }
            if (t.payoutId && t.transactionStatus === 'PAYOUT') batch.settledOrders.push({ externalOrderId: t.orderId, settlementId: t.payoutId, settledAt: t.transactionDate });
          } else if (t.transactionType === 'REFUND') {
            batch.refunds.push({
              externalRefundId: t.transactionId,
              externalOrderId: t.orderId,
              externalLineId: t.orderLineItems?.[0]?.lineItemId ?? null,
              amount: money2(t.amount?.value ?? 0),
              taxAmount: null,
              currency: t.amount?.currency,
              refundedAt: t.transactionDate,
              reason: t.transactionMemo ?? null,
            });
          } else if (t.transactionType === 'NON_SALE_CHARGE' && t.orderId) {
            batch.fees.push({
              externalRef: `${t.transactionId}`,
              externalOrderId: t.orderId,
              externalLineId: null,
              feeType: /AD/i.test(t.feeType ?? '') ? 'promoted' : 'other',
              name: t.feeType ?? 'Charge',
              amount: money2(t.amount?.value ?? 0),
              currency: t.amount?.currency,
              postedAt: t.transactionDate,
            });
          }
        }
        if (txs.length < 200) break;
        offset += 200;
      }
      return batch;
    });
  }

  fetchExistingListings(ctx: ConnectorContext) {
    return attempt(async () => {
      const token = await ebayUserToken(ctx);
      const listings: ExistingListing[] = [];
      for (let page = 1; page <= 500; page++) {
        const r = await tradingCall(
          'GetMyeBaySelling',
          this.site,
          token,
          { ActiveList: { Include: 'true', Pagination: { EntriesPerPage: 200, PageNumber: page } }, DetailLevel: 'ReturnAll' },
          ctx.accountId,
        );
        const items = asArray(r.ActiveList?.ItemArray?.Item);
        for (const it of items) {
          listings.push({
            externalListingId: String(it.ItemID),
            sku: it.SKU ?? '',
            title: it.Title ?? '',
            price: String(it.SellingStatus?.CurrentPrice?.['#text'] ?? it.BuyItNowPrice?.['#text'] ?? '0'),
            currency: it.SellingStatus?.CurrentPrice?.['@_currencyID'] ?? (this.marketplace === 'EBAY_UK' ? 'GBP' : 'USD'),
            quantity: Number(it.QuantityAvailable ?? it.Quantity ?? 0),
            state: Number(it.QuantityAvailable ?? it.Quantity ?? 0) > 0 ? 'ACTIVE' : 'PAUSED',
          });
        }
        const totalPages = Number(r.ActiveList?.PaginationResult?.TotalNumberOfPages ?? 1);
        if (page >= totalPages || items.length === 0) break;
      }
      return { listings };
    });
  }
}
