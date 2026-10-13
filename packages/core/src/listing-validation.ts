import { MARKETPLACES, MarketplaceCode } from './marketplaces';
import { d } from './money';

/**
 * Baseline per-marketplace listing rules.
 *
 * These are conservative defaults only. Category-specific required attributes
 * are NOT hard-coded: they are fetched at runtime from each marketplace's
 * metadata API (eBay Taxonomy API, Amazon Product Type Definitions API, TikTok
 * Shop category attribute API), cached per category, and passed in as
 * `requiredAttributes`. Limits below must be reviewed against current
 * marketplace documentation and can be overridden in settings.
 */
export interface MarketplaceListingRules {
  titleMaxLength: number;
  titleMinLength: number;
  maxImages: number;
  minImageLongestSidePx: number;
  recommendedImageLongestSidePx: number;
  allowedImageFormats: string[];
  requiresCondition: boolean;
  requiresShippingPolicy: boolean;
  requiresReturnPolicy: boolean;
  requiresBrand: boolean;
  requiresProductIdentifierOrExemption: boolean;
  maxBulletPoints: number;
  requiresDispatchTime: boolean;
}

export const DEFAULT_LISTING_RULES: Record<MarketplaceCode, MarketplaceListingRules> = {
  EBAY_UK: {
    titleMaxLength: 80, titleMinLength: 10, maxImages: 24, minImageLongestSidePx: 500, recommendedImageLongestSidePx: 1600,
    allowedImageFormats: ['jpeg', 'png', 'webp', 'gif', 'tiff', 'bmp'], requiresCondition: true, requiresShippingPolicy: true,
    requiresReturnPolicy: true, requiresBrand: false, requiresProductIdentifierOrExemption: false, maxBulletPoints: 0, requiresDispatchTime: true,
  },
  EBAY_US: {
    titleMaxLength: 80, titleMinLength: 10, maxImages: 24, minImageLongestSidePx: 500, recommendedImageLongestSidePx: 1600,
    allowedImageFormats: ['jpeg', 'png', 'webp', 'gif', 'tiff', 'bmp'], requiresCondition: true, requiresShippingPolicy: true,
    requiresReturnPolicy: true, requiresBrand: false, requiresProductIdentifierOrExemption: false, maxBulletPoints: 0, requiresDispatchTime: true,
  },
  AMAZON_UK: {
    titleMaxLength: 200, titleMinLength: 10, maxImages: 9, minImageLongestSidePx: 500, recommendedImageLongestSidePx: 1600,
    allowedImageFormats: ['jpeg', 'png', 'tiff', 'gif'], requiresCondition: true, requiresShippingPolicy: false,
    requiresReturnPolicy: false, requiresBrand: true, requiresProductIdentifierOrExemption: true, maxBulletPoints: 5, requiresDispatchTime: true,
  },
  TIKTOK_UK: {
    titleMaxLength: 255, titleMinLength: 25, maxImages: 9, minImageLongestSidePx: 300, recommendedImageLongestSidePx: 1200,
    allowedImageFormats: ['jpeg', 'png', 'webp'], requiresCondition: false, requiresShippingPolicy: false,
    requiresReturnPolicy: false, requiresBrand: false, requiresProductIdentifierOrExemption: false, maxBulletPoints: 0, requiresDispatchTime: true,
  },
};

export interface ListingImageInput {
  url: string;
  width?: number;
  height?: number;
  format?: string;
  sha256?: string;
  isMain?: boolean;
  /** Set by an image check that detected overlaid text / watermarks. */
  hasOverlayText?: boolean;
}

export interface ListingDraftInput {
  marketplace: MarketplaceCode;
  currency: string;
  title?: string | null;
  description?: string | null;
  bulletPoints?: string[];
  categoryId?: string | null;
  condition?: string | null;
  price?: string | number | null;
  quantityPolicy?: string | null;
  images?: ListingImageInput[];
  attributes?: Record<string, string | string[] | null | undefined>;
  shippingPolicyId?: string | null;
  returnPolicyId?: string | null;
  dispatchTimeDays?: number | null;
  brand?: string | null;
  gtin?: string | null;
  identifierExemption?: boolean;
  /** Attribute names marked required by the marketplace's category metadata. */
  requiredAttributes?: string[];
  /** Attributes whose values are confirmed by a human / verified source. */
  verifiedAttributes?: string[];
  /** Minimum profitable price in the listing currency, if computed. */
  minimumProfitablePrice?: string | number | null;
  restrictedProduct?: boolean;
  complianceSignedOff?: boolean;
}

export type Severity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  code: string;
  field: string;
  severity: Severity;
  /** Blocking issues prevent submission (errors) or approval/publication (blocking warnings). */
  blocking: boolean;
  message: string;
}

export interface ValidationResult {
  valid: boolean; // no errors
  complete: boolean; // no missing required fields
  blockingCount: number;
  issues: ValidationIssue[];
}

/** Phrases marketplaces commonly prohibit in titles. Configurable in settings. */
export const DEFAULT_PROMOTIONAL_PHRASES = ['free shipping', 'free delivery', 'best seller', 'bestseller', 'sale', '100% guaranteed', 'cheapest', 'hot item', 'limited offer'];

/** Claims that must be backed by a verified attribute or document before publication. */
export const DEFAULT_CLAIM_TERMS = [
  'certified', 'ce marked', 'ukca', 'fda', 'approved', 'waterproof', 'hypoallergenic', 'organic', 'antibacterial',
  'medical', 'genuine leather', '100% cotton', 'sterling silver', 'gold plated', 'authentic', 'official', 'licensed', 'next day delivery',
];

function wordMatch(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text);
}

export function validateListing(
  draft: ListingDraftInput,
  opts: { rules?: Partial<MarketplaceListingRules>; promotionalPhrases?: string[]; claimTerms?: string[] } = {},
): ValidationResult {
  const rules = { ...DEFAULT_LISTING_RULES[draft.marketplace], ...opts.rules };
  const issues: ValidationIssue[] = [];
  const err = (code: string, field: string, message: string) => issues.push({ code, field, severity: 'error', blocking: true, message });
  const warn = (code: string, field: string, message: string, blocking = false) =>
    issues.push({ code, field, severity: 'warning', blocking, message });
  const info = (code: string, field: string, message: string) => issues.push({ code, field, severity: 'info', blocking: false, message });
  const missing = (field: string, label: string) => err('REQUIRED', field, `${label} is required for ${MARKETPLACES[draft.marketplace].name}.`);

  // ---- Core fields -------------------------------------------------------
  const title = draft.title?.trim() ?? '';
  if (!title) missing('title', 'Title');
  else {
    if (title.length > rules.titleMaxLength) err('TITLE_TOO_LONG', 'title', `Title is ${title.length} characters; maximum is ${rules.titleMaxLength}.`);
    if (title.length < rules.titleMinLength) err('TITLE_TOO_SHORT', 'title', `Title must be at least ${rules.titleMinLength} characters.`);
    for (const p of opts.promotionalPhrases ?? DEFAULT_PROMOTIONAL_PHRASES) {
      if (wordMatch(title, p)) warn('PROMOTIONAL_PHRASE', 'title', `Title contains promotional wording "${p}", which marketplaces commonly prohibit.`, true);
    }
    if (/[A-Z]{6,}/.test(title) && title === title.toUpperCase()) warn('ALL_CAPS', 'title', 'Title is written in capitals.');
  }
  if (!draft.description?.trim()) missing('description', 'Description');
  if (!draft.categoryId) missing('categoryId', 'Category');
  if (rules.requiresCondition && !draft.condition) missing('condition', 'Condition');

  const expectedCurrency = MARKETPLACES[draft.marketplace].currency;
  if (draft.currency !== expectedCurrency) {
    err('CURRENCY_MISMATCH', 'currency', `${MARKETPLACES[draft.marketplace].name} listings are priced in ${expectedCurrency}, not ${draft.currency}.`);
  }
  if (draft.price === null || draft.price === undefined || draft.price === '') missing('price', 'Selling price');
  else if (d(draft.price).lte(0)) err('PRICE_INVALID', 'price', 'Selling price must be greater than zero.');
  else if (draft.minimumProfitablePrice !== null && draft.minimumProfitablePrice !== undefined && d(draft.price).lt(d(draft.minimumProfitablePrice))) {
    warn('BELOW_MIN_PROFITABLE_PRICE', 'price', `Price is below the minimum profitable price of ${d(draft.minimumProfitablePrice).toFixed(2)} ${draft.currency}.`, true);
  }
  if (!draft.quantityPolicy) missing('quantityPolicy', 'Quantity / availability policy');
  if (rules.requiresShippingPolicy && !draft.shippingPolicyId) missing('shippingPolicyId', 'Shipping policy');
  if (rules.requiresReturnPolicy && !draft.returnPolicyId) missing('returnPolicyId', 'Return policy');
  if (rules.requiresDispatchTime && (draft.dispatchTimeDays === null || draft.dispatchTimeDays === undefined)) missing('dispatchTimeDays', 'Dispatch time');
  if (rules.requiresBrand && !draft.brand?.trim()) missing('brand', 'Brand');
  if (rules.requiresProductIdentifierOrExemption && !draft.gtin && !draft.identifierExemption) {
    err('IDENTIFIER_REQUIRED', 'gtin', 'A product identifier (GTIN/EAN/UPC) or an approved identifier exemption is required.');
  }
  if (draft.gtin && !isValidGtin(draft.gtin)) err('GTIN_INVALID', 'gtin', 'GTIN check digit is invalid.');
  if (rules.maxBulletPoints > 0 && (draft.bulletPoints?.length ?? 0) > rules.maxBulletPoints) {
    err('TOO_MANY_BULLETS', 'bulletPoints', `At most ${rules.maxBulletPoints} bullet points are allowed.`);
  }

  // ---- Category attributes ----------------------------------------------
  const attrs = draft.attributes ?? {};
  for (const name of draft.requiredAttributes ?? []) {
    const v = attrs[name];
    if (v === undefined || v === null || (Array.isArray(v) ? v.length === 0 : String(v).trim() === '')) {
      err('ATTRIBUTE_REQUIRED', `attributes.${name}`, `Category requires the "${name}" attribute.`);
    }
  }
  const verified = new Set((draft.verifiedAttributes ?? []).map((s) => s.toLowerCase()));
  for (const [name, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null && v !== '' && !verified.has(name.toLowerCase())) {
      info('ATTRIBUTE_UNVERIFIED', `attributes.${name}`, `"${name}" has not been verified against the product or supplier data.`);
    }
  }

  // ---- Claims that need evidence ----------------------------------------
  const text = `${title}\n${draft.description ?? ''}\n${(draft.bulletPoints ?? []).join('\n')}`;
  for (const term of opts.claimTerms ?? DEFAULT_CLAIM_TERMS) {
    if (wordMatch(text, term) && !verified.has(term.toLowerCase())) {
      warn('UNVERIFIED_CLAIM', 'description', `Listing claims "${term}" but this is not backed by a verified attribute. Verify or remove before approval.`, true);
    }
  }

  // ---- Images -------------------------------------------------------------
  const images = draft.images ?? [];
  if (images.length === 0) err('IMAGE_REQUIRED', 'images', 'At least one image is required.');
  if (images.length > rules.maxImages) err('TOO_MANY_IMAGES', 'images', `At most ${rules.maxImages} images are allowed.`);
  if (images.length > 0 && images.filter((i) => i.isMain).length !== 1) {
    warn('MAIN_IMAGE', 'images', 'Select exactly one main image (the first image will be used).');
  }
  const hashes = new Map<string, number>();
  images.forEach((img, i) => {
    const longest = Math.max(img.width ?? 0, img.height ?? 0);
    if (img.width && img.height && longest < rules.minImageLongestSidePx) {
      err('IMAGE_TOO_SMALL', `images[${i}]`, `Image ${i + 1} is ${longest}px on its longest side; minimum is ${rules.minImageLongestSidePx}px.`);
    } else if (img.width && img.height && longest < rules.recommendedImageLongestSidePx) {
      info('IMAGE_LOW_RES', `images[${i}]`, `Image ${i + 1} is below the recommended ${rules.recommendedImageLongestSidePx}px.`);
    }
    if (img.format && !rules.allowedImageFormats.includes(img.format.toLowerCase().replace('jpg', 'jpeg'))) {
      err('IMAGE_FORMAT', `images[${i}]`, `Image ${i + 1} format ${img.format} is not accepted.`);
    }
    if (img.hasOverlayText) warn('IMAGE_TEXT', `images[${i}]`, `Image ${i + 1} appears to contain text or watermarks.`, img.isMain === true);
    if (img.sha256) {
      if (hashes.has(img.sha256)) warn('IMAGE_DUPLICATE', `images[${i}]`, `Image ${i + 1} duplicates image ${hashes.get(img.sha256)! + 1}.`);
      else hashes.set(img.sha256, i);
    }
  });

  // ---- Compliance -----------------------------------------------------------
  if (draft.restrictedProduct && !draft.complianceSignedOff) {
    warn('RESTRICTED_PRODUCT', 'compliance', 'Product is flagged as restricted/regulated; a compliance sign-off is required before approval.', true);
  }

  const complete = !issues.some((i) => i.code === 'REQUIRED' || i.code === 'ATTRIBUTE_REQUIRED' || i.code === 'IDENTIFIER_REQUIRED' || i.code === 'IMAGE_REQUIRED');
  return {
    valid: !issues.some((i) => i.severity === 'error'),
    complete,
    blockingCount: issues.filter((i) => i.blocking).length,
    issues,
  };
}

/** GTIN-8/12/13/14 check digit validation. */
export function isValidGtin(gtin: string): boolean {
  const s = gtin.replace(/\s/g, '');
  if (!/^\d{8}$|^\d{12,14}$/.test(s)) return false;
  const digits = s.split('').map(Number);
  const check = digits.pop()!;
  const total = digits.reverse().reduce((acc, n, i) => acc + n * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (total % 10)) % 10 === check;
}
