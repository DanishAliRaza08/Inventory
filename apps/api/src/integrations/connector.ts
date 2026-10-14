import type { MarketplaceCode } from '@fr/core';

/** Every marketplace operation the platform may perform. */
export const OPERATIONS = [
  'CONNECT_ACCOUNT',
  'FETCH_CATEGORIES',
  'FETCH_CATEGORY_ATTRIBUTES',
  'ADOPT_EXISTING_LISTINGS',
  'CREATE_LISTING',
  'REVISE_LISTING',
  'UPDATE_PRICE_QUANTITY',
  'PAUSE_LISTING',
  'END_LISTING',
  'GET_LISTING_STATUS',
  'FETCH_ORDERS',
  'PUSH_TRACKING',
  'FETCH_RETURNS',
  'FETCH_FEES',
  'FETCH_SETTLEMENTS',
] as const;
export type Operation = (typeof OPERATIONS)[number];

/**
 * built       — code complete against the official API contract and tested end-to-end against the
 *               mock marketplace server; awaiting verification with Fashion Rockstar's real credentials
 * verified    — confirmed against the real marketplace (sandbox and production) for this account
 * manual      — must be done by staff in the marketplace's own UI
 * unsupported — no official API for this account/region
 * planned     — not built yet
 */
export type CapabilityStatus = 'built' | 'verified' | 'planned' | 'manual' | 'unsupported' | 'implemented';

export interface Capability {
  status: CapabilityStatus;
  api?: string;
  notes?: string;
}

export interface PublishPayload {
  listingId: string;
  sku: string;
  price: string;
  currency: string;
  quantity: number;
  content: Record<string, any>;
  /** Publicly reachable (signed) image URLs, main image first. */
  images: Array<{ url: string; isMain: boolean }>;
  externalListingId?: string | null;
  externalOfferId?: string | null;
  accountSettings: Record<string, any>;
  variant: { sku: string; size?: string | null; colour?: string | null; weightGrams?: number | null };
}

export type ConnectorResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      transient: boolean;
      code: string;
      message: string;
      readable: string;
      httpStatus?: number;
      nextAction?: string;
      authExpired?: boolean;
    };

export interface ConnectorContext {
  accountId: string;
  environment: 'SANDBOX' | 'PRODUCTION' | 'DEMO';
  /** Decrypted credentials; only ever held in memory inside the worker. */
  credentials: Record<string, any> | null;
  /** Persist refreshed tokens (encrypted). */
  saveCredentials: (c: Record<string, any>) => Promise<void>;
  accountSettings: Record<string, any>;
  idempotencyKey: string;
}

/** Listing creation result. `PENDING` = accepted but awaiting marketplace review/processing. */
export interface PublishResult {
  externalListingId: string;
  externalOfferId?: string;
  status: 'ACTIVE' | 'PENDING';
}

export interface ListingStatusResult {
  state: 'ACTIVE' | 'PENDING' | 'FAILED' | 'ENDED' | 'PAUSED';
  reason?: string;
  quantity?: number;
  price?: string;
}

export interface NormalizedOrderLine {
  externalLineId: string;
  sku: string;
  title: string;
  quantity: number;
  unitPrice: string;
  shippingCharged: string;
  sellerDiscount: string;
  taxAmount: string | null;
  externalListingId?: string | null;
}

export interface NormalizedOrder {
  externalOrderId: string;
  status: 'PENDING' | 'PAID' | 'AWAITING_DISPATCH' | 'DISPATCHED' | 'DELIVERED' | 'CANCELLED';
  orderedAt: string;
  dispatchBy: string | null;
  deliveredAt?: string | null;
  currency: string;
  pricesIncludeTax: boolean;
  taxCollectedByMarketplace: boolean;
  lines: NormalizedOrderLine[];
  customer: { name?: string; email?: string; phone?: string; line1?: string; line2?: string; city?: string; region?: string; postcode?: string; country?: string } | null;
}

export interface NormalizedFee {
  externalRef: string;
  externalOrderId: string | null;
  externalLineId: string | null;
  feeType: string;
  name: string;
  amount: string; // positive = charge, negative = credit
  currency: string;
  postedAt: string;
  settlementId?: string | null;
}

export interface NormalizedRefund {
  externalRefundId: string;
  externalOrderId: string;
  externalLineId: string | null;
  amount: string;
  taxAmount: string | null;
  currency: string;
  refundedAt: string;
  reason?: string | null;
}

export interface FinancialBatch {
  fees: NormalizedFee[];
  refunds: NormalizedRefund[];
  /** Orders whose funds have been settled / paid out. */
  settledOrders: Array<{ externalOrderId: string; settlementId: string; settledAt: string }>;
  cursor: string | null;
}

export interface ExistingListing {
  externalListingId: string;
  sku: string;
  title: string;
  price: string;
  currency: string;
  quantity: number;
  state: 'ACTIVE' | 'PAUSED' | 'ENDED';
}

export interface MarketplaceConnector {
  readonly marketplace: MarketplaceCode;
  readonly capabilities: Record<Operation, Capability>;
  createListing(ctx: ConnectorContext, p: PublishPayload): Promise<ConnectorResult<PublishResult>>;
  reviseListing(ctx: ConnectorContext, p: PublishPayload): Promise<ConnectorResult<{ status: 'ACTIVE' | 'PENDING' }>>;
  setListingState(ctx: ConnectorContext, p: { externalListingId: string; externalOfferId?: string | null; sku: string; state: 'PAUSED' | 'ENDED' | 'ACTIVE'; quantity?: number; price?: string }): Promise<ConnectorResult<{ status: string }>>;
  updatePriceQuantity(ctx: ConnectorContext, p: { externalListingId: string; externalOfferId?: string | null; sku: string; price?: string; quantity?: number; currency: string }): Promise<ConnectorResult<{ ok: true }>>;
  getListingStatus(ctx: ConnectorContext, p: { externalListingId: string; sku: string }): Promise<ConnectorResult<ListingStatusResult>>;
  fetchCategoryAttributes(ctx: ConnectorContext, categoryId: string): Promise<ConnectorResult<{ required: string[]; optional: string[] }>>;
  fetchOrders(ctx: ConnectorContext, since: Date): Promise<ConnectorResult<{ orders: NormalizedOrder[] }>>;
  pushTracking(ctx: ConnectorContext, p: { externalOrderId: string; lines: Array<{ externalLineId: string; quantity: number }>; carrier: string; trackingNumber: string; shippedAt: Date }): Promise<ConnectorResult<{ ok: true }>>;
  fetchFinancials(ctx: ConnectorContext, since: Date): Promise<ConnectorResult<FinancialBatch>>;
  fetchExistingListings(ctx: ConnectorContext): Promise<ConnectorResult<{ listings: ExistingListing[] }>>;
}

export function notImplemented(op: Operation, marketplace: string): ConnectorResult<never> {
  return {
    ok: false,
    transient: false,
    code: 'CONNECTOR_NOT_IMPLEMENTED',
    message: `${op} is not available for ${marketplace}.`,
    readable: `${op.toLowerCase().replace(/_/g, ' ')} is not available for ${marketplace} through its official API.`,
    nextAction: 'Do this in the marketplace’s own seller tools.',
  };
}
