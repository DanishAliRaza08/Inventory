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

const ebayCaps = caps({
  CONNECT_ACCOUNT: { status: 'planned', api: 'OAuth 2.0 authorization code grant (user token) + refresh token' },
  FETCH_CATEGORIES: { status: 'planned', api: 'Commerce Taxonomy API getCategoryTree / getCategorySuggestions' },
  FETCH_CATEGORY_ATTRIBUTES: { status: 'planned', api: 'Commerce Taxonomy API getItemAspectsForCategory' },
  CREATE_LISTING: { status: 'planned', api: 'Sell Inventory API createOrReplaceInventoryItem → createOffer → publishOffer' },
  REVISE_LISTING: { status: 'planned', api: 'Sell Inventory API createOrReplaceInventoryItem / updateOffer' },
  UPDATE_PRICE_QUANTITY: { status: 'planned', api: 'Sell Inventory API bulkUpdatePriceQuantity' },
  PAUSE_LISTING: { status: 'planned', api: 'Set available quantity to 0 (out-of-stock control) via bulkUpdatePriceQuantity', notes: 'eBay has no "pause" state for fixed-price listings.' },
  END_LISTING: { status: 'planned', api: 'Sell Inventory API withdrawOffer' },
  GET_LISTING_STATUS: { status: 'planned', api: 'Sell Inventory API getOffer / getOffers' },
  FETCH_ORDERS: { status: 'planned', api: 'Sell Fulfillment API getOrders' },
  PUSH_TRACKING: { status: 'planned', api: 'Sell Fulfillment API createShippingFulfillment' },
  FETCH_RETURNS: { status: 'planned', api: 'Post-Order API (returns)', notes: 'Verify availability for the account before enabling.' },
  FETCH_FEES: { status: 'planned', api: 'Sell Finances API getTransactions' },
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
    CONNECT_ACCOUNT: { status: 'planned', api: 'Selling Partner API authorisation (LWA OAuth) with the required roles' },
    FETCH_CATEGORIES: { status: 'planned', api: 'Product Type Definitions API searchDefinitionsProductTypes' },
    FETCH_CATEGORY_ATTRIBUTES: { status: 'planned', api: 'Product Type Definitions API getDefinitionsProductType (JSON schema)' },
    CREATE_LISTING: { status: 'planned', api: 'Listings Items API putListingsItem (validation preview supported)', notes: 'Drafts live only in this platform; Amazon has no hosted draft for listings items.' },
    REVISE_LISTING: { status: 'planned', api: 'Listings Items API patchListingsItem' },
    UPDATE_PRICE_QUANTITY: { status: 'planned', api: 'Listings Items API patchListingsItem (purchasable_offer, fulfillment_availability)' },
    PAUSE_LISTING: { status: 'planned', api: 'Set fulfillment_availability quantity to 0' },
    END_LISTING: { status: 'planned', api: 'Listings Items API deleteListingsItem' },
    GET_LISTING_STATUS: { status: 'planned', api: 'Listings Items API getListingsItem (issues, status)' },
    FETCH_ORDERS: { status: 'planned', api: 'Orders API getOrders / getOrderItems (PII requires restricted data token)' },
    PUSH_TRACKING: { status: 'planned', api: 'Feeds API order fulfillment feed / Merchant Fulfillment', notes: 'Choose per account setup.' },
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
