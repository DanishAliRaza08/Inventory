import { Injectable } from '@nestjs/common';
import type { MarketplaceCode } from '@fr/core';
import { config } from '../config';
import { AmazonConnector } from './amazon/amazon-connector';
import { MarketplaceConnector } from './connector';
import { DemoConnector } from './connectors';
import { EbayConnector } from './ebay/ebay-connector';
import { TikTokConnector } from './tiktok/tiktok-connector';

@Injectable()
export class ConnectorRegistry {
  private readonly official: Record<MarketplaceCode, MarketplaceConnector> = {
    EBAY_UK: new EbayConnector('EBAY_UK'),
    EBAY_US: new EbayConnector('EBAY_US'),
    AMAZON_UK: new AmazonConnector(),
    TIKTOK_UK: new TikTokConnector(),
  };

  forAccount(account: { marketplace: MarketplaceCode | string; environment: 'SANDBOX' | 'PRODUCTION' | 'DEMO' }): MarketplaceConnector {
    if (account.environment === 'DEMO') {
      if (!config().DEMO_MODE) throw new Error('DEMO accounts can only be used when DEMO_MODE is enabled.');
      return new DemoConnector(account.marketplace as MarketplaceCode);
    }
    return this.official[account.marketplace as MarketplaceCode];
  }

  capabilityMatrix() {
    return Object.fromEntries(Object.entries(this.official).map(([k, c]) => [k, c.capabilities]));
  }
}
