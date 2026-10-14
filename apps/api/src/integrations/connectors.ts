import { randomUUID } from 'crypto';
import type { MarketplaceCode } from '@fr/core';
import { Capability, ConnectorContext, ConnectorResult, MarketplaceConnector, OPERATIONS, Operation, PublishPayload, PublishResult } from './connector';

const ok = <T>(data: T): ConnectorResult<T> => ({ ok: true, data });

/**
 * Demonstration connector. Only usable when DEMO_MODE=true AND the account's environment is DEMO.
 * It never contacts a marketplace; listing ids are prefixed DEMO- so they can never be mistaken
 * for real ones. (For realistic end-to-end testing use MOCK_MARKETPLACES with the real connectors.)
 */
export class DemoConnector implements MarketplaceConnector {
  constructor(readonly marketplace: MarketplaceCode) {}
  readonly capabilities = Object.fromEntries(OPERATIONS.map((op) => [op, { status: 'implemented', notes: 'Demonstration only, no marketplace calls' }])) as Record<Operation, Capability>;

  async createListing(_ctx: ConnectorContext, p: PublishPayload): Promise<ConnectorResult<PublishResult>> {
    if (String(p.content.title ?? '').includes('[demo-fail]')) {
      return { ok: false, transient: false, code: 'DEMO_VALIDATION', message: 'Demo rejection', readable: 'The demo marketplace rejected this listing because its title contains [demo-fail].' };
    }
    return ok({ externalListingId: `DEMO-${this.marketplace}-${randomUUID().slice(0, 8)}`, status: 'ACTIVE' });
  }
  async reviseListing() {
    return ok({ status: 'ACTIVE' as const });
  }
  async setListingState(_ctx: ConnectorContext, p: { state: 'PAUSED' | 'ENDED' | 'ACTIVE' }) {
    return ok({ status: p.state });
  }
  async updatePriceQuantity() {
    return ok({ ok: true as const });
  }
  async getListingStatus() {
    return ok({ state: 'ACTIVE' as const });
  }
  async fetchCategoryAttributes() {
    return ok({ required: ['Size', 'Colour'], optional: ['Material', 'Style', 'Pattern'] });
  }
  async fetchOrders() {
    return ok({ orders: [] });
  }
  async pushTracking() {
    return ok({ ok: true as const });
  }
  async fetchFinancials() {
    return ok({ fees: [], refunds: [], settledOrders: [], cursor: null });
  }
  async fetchExistingListings() {
    return ok({ listings: [] });
  }
}
