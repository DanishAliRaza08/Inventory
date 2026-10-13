import { Injectable } from '@nestjs/common';
import type { MarketplaceCode } from '@fr/core';
import { config } from '../config';
import { MarketplaceConnector } from './connector';
import { AmazonUkConnector, DemoConnector, EbayUkConnector, EbayUsConnector, TikTokUkConnector } from './connectors';

@Injectable()
export class ConnectorRegistry {
  private readonly official: Record<MarketplaceCode, MarketplaceConnector> = {
    EBAY_UK: new EbayUkConnector(),
    EBAY_US: new EbayUsConnector(),
    AMAZON_UK: new AmazonUkConnector(),
    TIKTOK_UK: new TikTokUkConnector(),
  };

  forAccount(account: { marketplace: MarketplaceCode; environment: 'SANDBOX' | 'PRODUCTION' | 'DEMO' }): MarketplaceConnector {
    if (account.environment === 'DEMO') {
      if (!config().DEMO_MODE) throw new Error('DEMO accounts can only be used when DEMO_MODE is enabled.');
      return new DemoConnector(account.marketplace);
    }
    return this.official[account.marketplace];
  }

  capabilityMatrix() {
    return Object.fromEntries(Object.entries(this.official).map(([k, c]) => [k, c.capabilities]));
  }
}
