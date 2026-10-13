/**
 * Marketplace contexts. eBay UK and eBay USA are deliberately separate contexts:
 * different currency, site, policies, categories and fee schedules.
 */
export const MARKETPLACES = {
  EBAY_UK: { code: 'EBAY_UK', name: 'eBay UK', channel: 'EBAY', country: 'GB', currency: 'GBP', locale: 'en-GB' },
  EBAY_US: { code: 'EBAY_US', name: 'eBay USA', channel: 'EBAY', country: 'US', currency: 'USD', locale: 'en-US' },
  AMAZON_UK: { code: 'AMAZON_UK', name: 'Amazon UK', channel: 'AMAZON', country: 'GB', currency: 'GBP', locale: 'en-GB' },
  TIKTOK_UK: { code: 'TIKTOK_UK', name: 'TikTok Shop UK', channel: 'TIKTOK', country: 'GB', currency: 'GBP', locale: 'en-GB' },
} as const;

export type MarketplaceCode = keyof typeof MARKETPLACES;
export const MARKETPLACE_CODES = Object.keys(MARKETPLACES) as MarketplaceCode[];

export function isMarketplaceCode(v: string): v is MarketplaceCode {
  return v in MARKETPLACES;
}
