import type { SupplierType } from '@prisma/client';
import { Capability } from './connector';

export const SUPPLIER_OPERATIONS = ['CONNECT_ACCOUNT', 'PRODUCT_DETAILS', 'PRICE_AND_STOCK', 'PLACE_ORDER', 'ORDER_STATUS', 'TRACKING'] as const;
export type SupplierOperation = (typeof SUPPLIER_OPERATIONS)[number];

const caps = (m: Partial<Record<SupplierOperation, Capability>>): Record<SupplierOperation, Capability> =>
  Object.fromEntries(SUPPLIER_OPERATIONS.map((o) => [o, m[o] ?? { status: 'manual' }])) as Record<SupplierOperation, Capability>;

export const SUPPLIER_CONNECTORS: Record<'ALIEXPRESS' | 'CJ_DROPSHIPPING' | 'MANUAL', { type: SupplierType; capabilities: Record<SupplierOperation, Capability> }> = {
  ALIEXPRESS: {
    type: 'ALIEXPRESS',
    capabilities: caps({
      CONNECT_ACCOUNT: { status: 'built', api: 'AliExpress Open Platform OAuth (/oauth/authorize → /auth/token/create, HMAC-SHA256 signed)', notes: 'Needs the approved app key/secret' },
      PRODUCT_DETAILS: { status: 'built', api: 'aliexpress.ds.product.get' },
      PRICE_AND_STOCK: { status: 'built', api: 'aliexpress.ds.product.get (SKU price, stock, ships-from)', notes: 'Scheduled every 6h; feeds price history, cost records and stock checks' },
      PLACE_ORDER: { status: 'built', api: 'aliexpress.ds.order.create', notes: 'Only after staff confirmation' },
      ORDER_STATUS: { status: 'built', api: 'aliexpress.ds.order.tracking.get' },
      TRACKING: { status: 'built', api: 'aliexpress.ds.order.tracking.get', notes: 'Tracking is pushed to the marketplace once returned' },
    }),
  },
  CJ_DROPSHIPPING: {
    type: 'CJ_DROPSHIPPING',
    capabilities: caps({
      CONNECT_ACCOUNT: { status: 'built', api: 'CJ API v2 getAccessToken (API key)' },
      PRODUCT_DETAILS: { status: 'built', api: 'CJ variant query by vid' },
      PRICE_AND_STOCK: { status: 'built', api: 'CJ stock by vid (per warehouse; UK warehouse preferred)' },
      PLACE_ORDER: { status: 'built', api: 'CJ createOrderV2', notes: 'Only after staff confirmation' },
      ORDER_STATUS: { status: 'built', api: 'CJ logistic trackInfo' },
      TRACKING: { status: 'built', api: 'CJ logistic trackInfo' },
    }),
  },
  MANUAL: { type: 'MANUAL', capabilities: caps({}) },
};
