import { randomUUID } from 'crypto';
import type { MarketplaceCode } from '@fr/core';
import { Capability, ConnectorContext, ConnectorResult, MarketplaceConnector, OPERATIONS, Operation, PublishPayload, notImplemented } from './connector';

function caps(map: Partial<Record<Operation, Capability>>): Record<Operation, Capability> {
  return Object.fromEntries(OPERATIONS.map((op) => [op, map[op] ?? { status: 'planned' }])) as Record<Operation, Capability>;
}

/**
 * Official-API connectors. The capability tables document which official API each
 * operation maps to; operations stay `planned` (and return CONNECTOR_NOT_IMPLEMENTED)
 * until implemented and verified against the marketplace for the account and region.
 */
abstract class OfficialConnector implements MarketplaceConnector {
  abstract readonly marketplace: MarketplaceCode;
  abstract readonly capabilities: Record<Operation, Capability>;
  async createListing(_ctx: ConnectorContext, _p: PublishPayload): Promise<ConnectorResult<never>> {
    return notImplemented('CREATE_LISTING', this.marketplace);
  }
  async reviseListing(_ctx: ConnectorContext, _p: PublishPayload): Promise<ConnectorResult<never>> {
    return notImplemented('REVISE_LISTING', this.marketplace);
  }
  async setListingState(): Promise<ConnectorResult<never>> {
    return notImplemented('END_LISTING', this.marketplace);
  }
}

/**
 * Decision (Oct 2026): Fashion Rockstar keeps managing eBay listings the existing way, so
 * listing operations use the **Trading API**. Listings stay editable in Seller Hub, existing
 * listings are adopted without migration, and nothing is moved to the Inventory API (whose
 * listings can no longer be edited in Seller Hub). REST APIs are used where they do not
 * affect how listings are managed (taxonomy, business policies, orders, finances).
 */
const ebayCaps = caps({
  CONNECT_ACCOUNT: { status: 'planned', api: 'OAuth 2.0 authorization code grant (user token + refresh token); the same token authorises Trading API calls', notes: 'Requires eBay developer program production keyset; subscribe to marketplace account deletion notifications' },
  FETCH_CATEGORIES: { status: 'planned', api: 'Commerce Taxonomy API getCategoryTree / getCategorySuggestions (EBAY_GB / EBAY_US)' },
  FETCH_CATEGORY_ATTRIBUTES: { status: 'planned', api: 'Commerce Taxonomy API getItemAspectsForCategory' },
  ADOPT_EXISTING_LISTINGS: { status: 'planned', api: 'Trading API GetSellerList / GetMyeBaySelling + GetItem', notes: 'Imports existing Seller Hub listings as ACTIVE (confirmed by eBay) and links them to master SKUs by Custom Label (SKU); no migration' },
  CREATE_LISTING: { status: 'planned', api: 'Trading API VerifyAddFixedPriceItem → AddFixedPriceItem', notes: 'Verify call used as the pre-publication check; SKU in the Custom Label; business policies by profile id' },
  REVISE_LISTING: { status: 'planned', api: 'Trading API ReviseFixedPriceItem' },
  UPDATE_PRICE_QUANTITY: { status: 'planned', api: 'Trading API ReviseInventoryStatus (up to 4 items per call)' },
  PAUSE_LISTING: { status: 'planned', api: 'Trading API ReviseInventoryStatus quantity 0 (with out-of-stock control enabled)', notes: 'eBay fixed-price listings have no "pause" state' },
  END_LISTING: { status: 'planned', api: 'Trading API EndFixedPriceItem' },
  GET_LISTING_STATUS: { status: 'planned', api: 'Trading API GetItem' },
  FETCH_ORDERS: { status: 'planned', api: 'Sell Fulfillment API getOrders' },
  PUSH_TRACKING: { status: 'planned', api: 'Sell Fulfillment API createShippingFulfillment' },
  FETCH_RETURNS: { status: 'planned', api: 'Post-Order API (returns, cancellations)', notes: 'Verify availability for the UK/US accounts' },
  FETCH_FEES: { status: 'planned', api: 'Sell Finances API getTransactions', notes: 'Digital signatures required for UK/EU sellers' },
  FETCH_SETTLEMENTS: { status: 'planned', api: 'Sell Finances API getPayouts' },
});

export class EbayUkConnector extends OfficialConnector {
  readonly marketplace = 'EBAY_UK' as const;
  readonly capabilities = ebayCaps;
}

export class EbayUsConnector extends OfficialConnector {
  readonly marketplace = 'EBAY_US' as const;
  readonly capabilities = ebayCaps;
}

export class AmazonUkConnector extends OfficialConnector {
  readonly marketplace = 'AMAZON_UK' as const;
  readonly capabilities = caps({
    CONNECT_ACCOUNT: { status: 'planned', api: 'Selling Partner API authorisation (LWA OAuth) with roles: Product Listing, Pricing, Inventory and Order Tracking, Direct-to-Consumer Shipping (restricted), Finance and Accounting' },
    FETCH_CATEGORIES: { status: 'planned', api: 'Product Type Definitions API searchDefinitionsProductTypes' },
    FETCH_CATEGORY_ATTRIBUTES: { status: 'planned', api: 'Product Type Definitions API getDefinitionsProductType (JSON schema)' },
    ADOPT_EXISTING_LISTINGS: { status: 'planned', api: 'Reports API GET_MERCHANT_LISTINGS_ALL_DATA + Listings Items API getListingsItem', notes: 'Links existing offers to master SKUs by seller SKU' },
    CREATE_LISTING: { status: 'planned', api: 'Listings Items API putListingsItem (validation preview supported)', notes: 'Drafts live only in this platform; Amazon has no hosted draft for listings items.' },
    REVISE_LISTING: { status: 'planned', api: 'Listings Items API patchListingsItem' },
    UPDATE_PRICE_QUANTITY: { status: 'planned', api: 'Listings Items API patchListingsItem (purchasable_offer, fulfillment_availability)' },
    PAUSE_LISTING: { status: 'planned', api: 'Set fulfillment_availability quantity to 0' },
    END_LISTING: { status: 'planned', api: 'Listings Items API deleteListingsItem' },
    GET_LISTING_STATUS: { status: 'planned', api: 'Listings Items API getListingsItem (issues, status)' },
    FETCH_ORDERS: { status: 'planned', api: 'Orders API getOrders / getOrderItems; buyer address via Restricted Data Token (Tokens API)', notes: 'Self-fulfilled (merchant-fulfilled) orders: requires the restricted Direct-to-Consumer Shipping role; PII encrypted, access audited, deleted ≤ 30 days after delivery' },
    PUSH_TRACKING: { status: 'planned', api: 'Orders API confirmShipment', notes: 'Merchant-fulfilled: carrier + tracking confirmed after dispatch' },
    FETCH_RETURNS: { status: 'planned', api: 'Reports API returns reports' },
    FETCH_FEES: { status: 'planned', api: 'Finances API listFinancialEvents' },
    FETCH_SETTLEMENTS: { status: 'planned', api: 'Reports API settlement reports' },
  });
}

export class TikTokUkConnector extends OfficialConnector {
  readonly marketplace = 'TIKTOK_UK' as const;
  readonly capabilities = caps({
    CONNECT_ACCOUNT: { status: 'planned', api: 'TikTok Shop Partner Center app authorisation (OAuth) for the UK shop' },
    FETCH_CATEGORIES: { status: 'planned', api: 'Product API get categories' },
    FETCH_CATEGORY_ATTRIBUTES: { status: 'planned', api: 'Product API get attributes / category rules' },
    ADOPT_EXISTING_LISTINGS: { status: 'planned', api: 'Product API search products + get product', notes: 'Links existing products to master SKUs by seller SKU' },
    CREATE_LISTING: { status: 'planned', api: 'Product API create product (requires images uploaded via upload image)' },
    REVISE_LISTING: { status: 'planned', api: 'Product API edit / partial edit product' },
    UPDATE_PRICE_QUANTITY: { status: 'planned', api: 'Product API update price / update inventory' },
    PAUSE_LISTING: { status: 'planned', api: 'Product API deactivate products' },
    END_LISTING: { status: 'planned', api: 'Product API delete products' },
    GET_LISTING_STATUS: { status: 'planned', api: 'Product API get product (audit status / failure reasons)' },
    FETCH_ORDERS: { status: 'planned', api: 'Order API search orders / get order detail' },
    PUSH_TRACKING: { status: 'planned', api: 'Fulfillment API (ship package / update tracking)' },
    FETCH_RETURNS: { status: 'planned', api: 'Return and Refund API' },
    FETCH_FEES: { status: 'planned', api: 'Finance API statements / order transactions' },
    FETCH_SETTLEMENTS: { status: 'planned', api: 'Finance API payments / statements' },
  });
}

/**
 * Demonstration connector. Only usable when DEMO_MODE=true AND the marketplace account's
 * environment is DEMO. It never contacts a marketplace and every listing id it returns is
 * prefixed DEMO- so it can never be mistaken for a real marketplace listing.
 */
export class DemoConnector implements MarketplaceConnector {
  constructor(readonly marketplace: MarketplaceCode) {}
  readonly capabilities = caps(Object.fromEntries(OPERATIONS.map((op) => [op, { status: 'implemented', notes: 'Demonstration only, no marketplace calls' }])));

  async createListing(_ctx: ConnectorContext, p: PublishPayload) {
    const fail = String((p.content as { title?: string }).title ?? '').includes('[demo-fail]');
    if (fail) {
      return { ok: false as const, transient: false, code: 'DEMO_VALIDATION', message: 'Demo rejection', readable: 'The demo marketplace rejected this listing because its title contains [demo-fail].' };
    }
    return { ok: true as const, data: { externalListingId: `DEMO-${this.marketplace}-${randomUUID().slice(0, 8)}`, status: 'ACTIVE' as const } };
  }
  async reviseListing() {
    return { ok: true as const, data: { status: 'ACTIVE' as const } };
  }
  async setListingState(_ctx: ConnectorContext, p: { externalListingId: string; state: 'PAUSED' | 'ENDED' | 'ACTIVE' }) {
    return { ok: true as const, data: { status: p.state } };
  }
}
