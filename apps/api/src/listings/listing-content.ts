import { MARKETPLACES, MarketplaceCode, DEFAULT_LISTING_RULES } from '@fr/core';
import { z } from 'zod';

/** Marketplace-specific listing content, snapshotted per ListingVersion. */
export const ListingContent = z.object({
  title: z.string().max(500).default(''),
  description: z.string().max(50000).default(''),
  bulletPoints: z.array(z.string().max(1000)).max(10).default([]),
  categoryId: z.string().max(64).nullable().default(null),
  categoryName: z.string().max(300).nullable().default(null),
  condition: z.string().max(40).nullable().default(null),
  attributes: z.record(z.union([z.string(), z.array(z.string())])).default({}),
  /** From the marketplace's category metadata (cached per category). */
  requiredAttributes: z.array(z.string()).default([]),
  /** Attributes / claims a human has confirmed against product or supplier evidence. */
  verifiedAttributes: z.array(z.string()).default([]),
  /** Ordered ProductImage ids; the first is the main image. */
  imageIds: z.array(z.string().uuid()).default([]),
  shippingPolicyId: z.string().max(100).nullable().default(null),
  returnPolicyId: z.string().max(100).nullable().default(null),
  dispatchTimeDays: z.number().int().min(0).max(30).nullable().default(null),
  quantityPolicy: z.enum(['SYNC', 'FIXED', 'MANUAL']).nullable().default('SYNC'),
  fixedQuantity: z.number().int().min(0).nullable().default(null),
  brand: z.string().max(120).nullable().default(null),
  gtin: z.string().max(14).nullable().default(null),
  identifierExemption: z.boolean().default(false),
  searchKeywords: z.array(z.string().max(100)).max(50).default([]),
  handlingInstructions: z.string().max(2000).nullable().default(null),
  notes: z.string().max(5000).nullable().default(null),
  /** Set only by users with listings.approve. */
  complianceSignedOff: z.boolean().default(false),
});
export type ListingContentT = z.infer<typeof ListingContent>;

export const ListingContentPatch = ListingContent.partial();

export interface TemplateVars {
  title: string;
  brand?: string | null;
  colour?: string | null;
  size?: string | null;
  material?: string | null;
  category?: string | null;
  description?: string | null;
  sku: string;
}

/**
 * Minimal mustache-style renderer: {{var}} and {{#var}}…{{/var}} sections that render only when
 * the value exists, so missing facts are omitted rather than invented.
 */
export function renderTemplate(tpl: string, vars: TemplateVars): string {
  const v = vars as unknown as Record<string, string | null | undefined>;
  const sections = tpl.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, key: string, inner: string) => (v[key] ? inner : ''));
  return sections.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => v[key] ?? '').replace(/[ \t]+/g, ' ').replace(/ ([,.;:])/g, '$1').trim();
}

/** Trim a title to the marketplace limit at a word boundary. */
export function fitTitle(title: string, max: number): { title: string; truncated: boolean } {
  if (title.length <= max) return { title, truncated: false };
  const cut = title.slice(0, max + 1);
  const at = cut.lastIndexOf(' ');
  return { title: (at > max * 0.6 ? cut.slice(0, at) : title.slice(0, max)).trim(), truncated: true };
}

export const BUILT_IN_TEMPLATES: Record<MarketplaceCode, { title: string; description: string; bullets: string[] }> = {
  EBAY_UK: {
    title: '{{#brand}}{{brand}} {{/brand}}{{title}}{{#colour}} {{colour}}{{/colour}}{{#size}} Size {{size}}{{/size}}',
    description: '{{description}}{{#material}}\n\nMaterial: {{material}}{{/material}}{{#size}}\nSize: {{size}}{{/size}}{{#colour}}\nColour: {{colour}}{{/colour}}',
    bullets: [],
  },
  EBAY_US: {
    title: '{{#brand}}{{brand}} {{/brand}}{{title}}{{#colour}} {{colour}}{{/colour}}{{#size}} Size {{size}}{{/size}}',
    description: '{{description}}{{#material}}\n\nMaterial: {{material}}{{/material}}{{#size}}\nSize: {{size}}{{/size}}{{#colour}}\nColor: {{colour}}{{/colour}}',
    bullets: [],
  },
  AMAZON_UK: {
    title: '{{#brand}}{{brand}} {{/brand}}{{title}}{{#colour}}, {{colour}}{{/colour}}{{#size}}, Size {{size}}{{/size}}',
    description: '{{description}}',
    bullets: ['{{#material}}Material: {{material}}{{/material}}', '{{#size}}Size: {{size}}{{/size}}', '{{#colour}}Colour: {{colour}}{{/colour}}'],
  },
  TIKTOK_UK: {
    title: '{{title}}{{#colour}} - {{colour}}{{/colour}}{{#size}} - Size {{size}}{{/size}}',
    description: '{{description}}{{#material}}\n\nMaterial: {{material}}{{/material}}',
    bullets: [],
  },
};

export function buildContentFromMaster(
  marketplace: MarketplaceCode,
  vars: TemplateVars,
  imageIds: string[],
  extra: { gtin?: string | null; attributes?: Record<string, string>; defaults?: Partial<ListingContentT> },
  tpl?: { title: string; description: string; bullets: string[] },
): { content: ListingContentT; notes: string[] } {
  const t = tpl ?? BUILT_IN_TEMPLATES[marketplace];
  const notes: string[] = [];
  const rendered = renderTemplate(t.title, vars);
  const fitted = fitTitle(rendered, DEFAULT_LISTING_RULES[marketplace].titleMaxLength);
  if (fitted.truncated) notes.push(`Title shortened to ${fitted.title.length} characters for ${MARKETPLACES[marketplace].name}; review wording.`);
  const attributes: Record<string, string> = { ...(extra.attributes ?? {}) };
  if (vars.size) attributes.Size = vars.size;
  if (vars.colour) attributes[marketplace === 'EBAY_US' ? 'Color' : 'Colour'] = vars.colour;
  if (vars.material) attributes.Material = vars.material;
  if (vars.brand) attributes.Brand = vars.brand;
  const content = ListingContent.parse({
    ...extra.defaults,
    title: fitted.title,
    description: renderTemplate(t.description, vars).replace(/\n{3,}/g, '\n\n'),
    bulletPoints: t.bullets.map((b) => renderTemplate(b, vars)).filter(Boolean),
    attributes: { ...attributes, ...(extra.defaults?.attributes ?? {}) },
    imageIds,
    brand: vars.brand ?? null,
    gtin: extra.gtin ?? null,
  });
  return { content, notes };
}
