import type { MarketplaceCode } from '@fr/core';

/** Every marketplace operation the platform may perform. */
export const OPERATIONS = [
  'CONNECT_ACCOUNT',
  'FETCH_CATEGORIES',
  'FETCH_CATEGORY_ATTRIBUTES',
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
 * implemented   — built and tested against the marketplace's sandbox/production API
 * planned       — the official API supports it; connector code not yet written (Phase 3+)
 * manual        — must be done by staff in the marketplace's own UI
 * unsupported   — no official API for this account/region
 */
export type CapabilityStatus = 'implemented' | 'planned' | 'manual' | 'unsupported';

export interface Capability {
  status: CapabilityStatus;
  /** Official API / operation this maps to. */
  api?: string;
  notes?: string;
}

export interface PublishPayload {
  listingId: string;
  sku: string;
  price: string;
  currency: string;
  quantity: number;
  content: Record<string, unknown>;
  images: Array<{ url: string; isMain: boolean }>;
  externalListingId?: string | null;
  externalOfferId?: string | null;
}

export type ConnectorResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      /** Transient errors (timeouts, 429, 5xx) are retried with backoff; permanent ones are not. */
      transient: boolean;
      code: string;
      message: string;
      /** Plain-English explanation for staff. */
      readable: string;
      httpStatus?: number;
      nextAction?: string;
    };

export interface ConnectorContext {
  accountId: string;
  environment: 'SANDBOX' | 'PRODUCTION' | 'DEMO';
  /** Decrypted credentials, only ever held in memory inside the worker. */
  credentials: Record<string, unknown> | null;
  /** Stable key per logical operation, forwarded to marketplaces that support idempotency. */
  idempotencyKey: string;
}

export interface MarketplaceConnector {
  readonly marketplace: MarketplaceCode;
  readonly capabilities: Record<Operation, Capability>;
  createListing(ctx: ConnectorContext, p: PublishPayload): Promise<ConnectorResult<{ externalListingId: string; externalOfferId?: string; status: 'ACTIVE' }>>;
  reviseListing(ctx: ConnectorContext, p: PublishPayload): Promise<ConnectorResult<{ status: 'ACTIVE' }>>;
  setListingState(ctx: ConnectorContext, p: { externalListingId: string; state: 'PAUSED' | 'ENDED' | 'ACTIVE' }): Promise<ConnectorResult<{ status: string }>>;
}

export function notImplemented(op: Operation, marketplace: string): ConnectorResult<never> {
  return {
    ok: false,
    transient: false,
    code: 'CONNECTOR_NOT_IMPLEMENTED',
    message: `${op} is not yet implemented for ${marketplace}.`,
    readable: `Publishing to ${marketplace} is not available yet: the official API integration is scheduled for Phase 3. Your draft is safe; nothing was sent to the marketplace.`,
    nextAction: 'Keep the listing as approved, or list it manually on the marketplace and record the listing ID.',
  };
}
