import type { SupplierType } from '@prisma/client';
import { Capability } from './connector';

/** Operations the platform performs against a supplier. */
export const SUPPLIER_OPERATIONS = ['CONNECT_ACCOUNT', 'PRODUCT_DETAILS', 'PRICE_AND_STOCK', 'PLACE_ORDER', 'ORDER_STATUS', 'TRACKING'] as const;
export type SupplierOperation = (typeof SUPPLIER_OPERATIONS)[number];

export interface SupplierPriceStock {
  supplierProductId: string;
  price: string;
  shippingCost: string | null;
  currency: string;
  stockStatus: 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK' | 'UNKNOWN' | 'DISCONTINUED';
  reportedQuantity: number | null;
  shipsFromCountry: string | null;
  observedAt: Date;
}

/**
 * Supplier connector contract. Results feed the existing paths: price changes go through
 * SuppliersService.updatePrice (history + effective-dated cost + alert) and stock through
 * recordStock (source + timestamp; never treated as owned stock).
 */
export interface SupplierConnector {
  readonly type: SupplierType;
  readonly capabilities: Record<SupplierOperation, Capability>;
}

const caps = (m: Partial<Record<SupplierOperation, Capability>>): Record<SupplierOperation, Capability> =>
  Object.fromEntries(SUPPLIER_OPERATIONS.map((o) => [o, m[o] ?? { status: 'manual' }])) as Record<SupplierOperation, Capability>;

/**
 * AliExpress — official AliExpress Open Platform dropshipping (DS) APIs.
 * Requires an approved developer/dropshipper app (app key + secret) and the seller's
 * authorisation. Exact method names and versions are confirmed against the Open Platform
 * documentation for the approved app before each operation is switched to `implemented`.
 * Without approval every operation stays manual (staff record checks with source and time).
 */
export const ALIEXPRESS: SupplierConnector = {
  type: 'ALIEXPRESS',
  capabilities: caps({
    CONNECT_ACCOUNT: { status: 'planned', api: 'AliExpress Open Platform app authorisation (OAuth, signed requests with app secret)', notes: 'Needs confirmation that the account/app is approved for the DS APIs' },
    PRODUCT_DETAILS: { status: 'planned', api: 'DS product query API (product, SKU attributes, images, ship-from warehouses)' },
    PRICE_AND_STOCK: { status: 'planned', api: 'DS product query API — per-SKU price, stock and ship-from country', notes: 'Polled on a schedule; stale after 48h' },
    PLACE_ORDER: { status: 'planned', api: 'DS order create API', notes: 'Always requires staff confirmation; never automatic' },
    ORDER_STATUS: { status: 'planned', api: 'DS order query API' },
    TRACKING: { status: 'planned', api: 'DS logistics / tracking query API', notes: 'Dispatch recorded only once a tracking number is returned' },
  }),
};

export const CJ_DROPSHIPPING: SupplierConnector = {
  type: 'CJ_DROPSHIPPING',
  capabilities: caps({
    CONNECT_ACCOUNT: { status: 'planned', api: 'CJ Dropshipping API access token (API key from the CJ account)' },
    PRODUCT_DETAILS: { status: 'planned', api: 'CJ product query / variant query' },
    PRICE_AND_STOCK: { status: 'planned', api: 'CJ inventory by variant (per warehouse, incl. UK/US warehouses)' },
    PLACE_ORDER: { status: 'planned', api: 'CJ create order', notes: 'Always requires staff confirmation' },
    ORDER_STATUS: { status: 'planned', api: 'CJ order query' },
    TRACKING: { status: 'planned', api: 'CJ logistics tracking query' },
  }),
};

export const MANUAL: SupplierConnector = { type: 'MANUAL', capabilities: caps({}) };

export const SUPPLIER_CONNECTORS = { ALIEXPRESS, CJ_DROPSHIPPING, MANUAL } as const;
