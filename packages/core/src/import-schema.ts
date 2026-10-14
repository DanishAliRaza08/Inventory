import { z } from 'zod';
import { MARKETPLACE_CODES } from './marketplaces';
import { isValidGtin } from './listing-validation';

/**
 * Canonical product import columns. The import wizard maps arbitrary spreadsheet
 * headers onto these fields, validates each row and previews changes before
 * anything is written.
 */
export const IMPORT_FIELDS = {
  product_id: { label: 'Internal product ID', required: false, synonyms: ['id', 'internal id', 'product id'] },
  parent_sku: { label: 'Parent SKU (for variations)', required: false, synonyms: ['parent', 'parent sku', 'group sku'] },
  sku: { label: 'Master SKU', required: true, synonyms: ['sku', 'master sku', 'item sku', 'custom label', 'seller sku'] },
  title: { label: 'Title', required: true, synonyms: ['title', 'product title', 'name', 'product name'] },
  description: { label: 'Description', required: false, synonyms: ['description', 'desc', 'product description'] },
  category: { label: 'Category', required: false, synonyms: ['category', 'product category'] },
  brand: { label: 'Brand', required: false, synonyms: ['brand', 'manufacturer'] },
  barcode: { label: 'Barcode (GTIN/EAN/UPC)', required: false, synonyms: ['barcode', 'ean', 'upc', 'gtin'] },
  size: { label: 'Size', required: false, synonyms: ['size'] },
  colour: { label: 'Colour', required: false, synonyms: ['colour', 'color'] },
  material: { label: 'Material', required: false, synonyms: ['material', 'fabric'] },
  weight_g: { label: 'Weight (g)', required: false, synonyms: ['weight', 'weight g', 'weight (g)', 'weight grams'] },
  supplier: { label: 'Supplier', required: false, synonyms: ['supplier', 'supplier name', 'vendor'] },
  supplier_url: { label: 'Supplier URL', required: false, synonyms: ['supplier url', 'supplier link', 'source url', 'url'] },
  supplier_sku: { label: 'Supplier SKU', required: false, synonyms: ['supplier sku', 'vendor sku'] },
  supplier_product_id: { label: 'Supplier product ID', required: false, synonyms: ['supplier product id', 'source id'] },
  ships_from: { label: 'Ships from country (ISO, e.g. CN, GB)', required: false, synonyms: ['ships from', 'ship from', 'origin', 'warehouse country', 'ships from country'] },
  cost: { label: 'Supplier unit cost', required: false, synonyms: ['cost', 'unit cost', 'supplier price', 'purchase price', 'buy price'] },
  supplier_shipping: { label: 'Supplier shipping per unit', required: false, synonyms: ['shipping', 'supplier shipping', 'shipping cost'] },
  packaging: { label: 'Packaging per unit', required: false, synonyms: ['packaging', 'packaging cost'] },
  currency: { label: 'Cost currency', required: false, synonyms: ['currency', 'cost currency'] },
  fulfilment_model: { label: 'Fulfilment model (PHYSICAL/DROPSHIP)', required: false, synonyms: ['fulfilment', 'fulfillment', 'fulfilment model'] },
  stock: { label: 'Stock / supplier quantity', required: false, synonyms: ['stock', 'qty', 'quantity', 'inventory'] },
  safety_stock: { label: 'Safety stock', required: false, synonyms: ['safety stock', 'buffer'] },
  selling_price: { label: 'Selling price', required: false, synonyms: ['price', 'selling price', 'sale price', 'rrp'] },
  marketplace: { label: 'Marketplace (EBAY_UK, EBAY_US, AMAZON_UK, TIKTOK_UK)', required: false, synonyms: ['marketplace', 'channel'] },
  marketplace_sku: { label: 'Marketplace SKU', required: false, synonyms: ['marketplace sku', 'channel sku', 'listing sku'] },
} as const;

export type ImportField = keyof typeof IMPORT_FIELDS;
export const IMPORT_FIELD_KEYS = Object.keys(IMPORT_FIELDS) as ImportField[];

const norm = (s: string) => s.toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Suggest a column mapping from spreadsheet headers to import fields. */
export function suggestMapping(headers: string[]): Partial<Record<ImportField, string>> {
  const out: Partial<Record<ImportField, string>> = {};
  const used = new Set<string>();
  for (const key of IMPORT_FIELD_KEYS) {
    const candidates = [key.replace(/_/g, ' '), ...IMPORT_FIELDS[key].synonyms].map(norm);
    const h = headers.find((x) => !used.has(x) && candidates.includes(norm(x)));
    if (h) {
      out[key] = h;
      used.add(h);
    }
  }
  return out;
}

const blankToUndef = (v: unknown) => {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'string') return v.trim() === '' ? undefined : v.trim();
  return v;
};
/** Spreadsheet cells may arrive as numbers (e.g. SKU 10001); text fields are normalised to strings. */
const toText = (v: unknown) => {
  const b = blankToUndef(v);
  return b === undefined ? undefined : String(b).trim();
};
const money = z.preprocess(
  (v) => {
    const b = blankToUndef(v);
    return typeof b === 'string' ? b.replace(/[£$€,\s]/g, '') : b;
  },
  z.union([z.string(), z.number()]).pipe(z.coerce.number().nonnegative().finite()).optional(),
);
const int = z.preprocess(blankToUndef, z.coerce.number().int().nonnegative().optional());
const str = (max: number) => z.preprocess(toText, z.string().max(max).optional());

export const ImportRowSchema = z
  .object({
    product_id: str(64),
    parent_sku: str(64),
    sku: z.preprocess(toText, z.string({ required_error: 'SKU is required' }).max(64).regex(/^[A-Za-z0-9._\-\/]+$/, 'SKU may only contain letters, digits and . _ - /')),
    title: z.preprocess(toText, z.string({ required_error: 'Title is required' }).max(500)),
    description: str(20000),
    category: str(200),
    brand: str(120),
    barcode: z.preprocess(toText, z.string().refine(isValidGtin, 'Invalid GTIN/EAN/UPC check digit').optional()),
    size: str(60),
    colour: str(60),
    material: str(120),
    weight_g: int,
    supplier: str(120),
    supplier_url: z.preprocess(blankToUndef, z.string().url('Supplier URL must be a valid URL').optional()),
    supplier_sku: str(120),
    supplier_product_id: str(120),
    ships_from: z.preprocess((v) => (typeof blankToUndef(v) === 'string' ? (v as string).trim().toUpperCase() : blankToUndef(v)), z.string().regex(/^[A-Z]{2}$/, 'Ships-from must be a 2-letter country code').optional()),
    cost: money,
    supplier_shipping: money,
    packaging: money,
    currency: z.preprocess((v) => (typeof blankToUndef(v) === 'string' ? (v as string).trim().toUpperCase() : blankToUndef(v)), z.string().regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter ISO code').optional()),
    fulfilment_model: z.preprocess((v) => (typeof blankToUndef(v) === 'string' ? (v as string).trim().toUpperCase() : blankToUndef(v)), z.enum(['PHYSICAL', 'DROPSHIP']).optional()),
    stock: int,
    safety_stock: int,
    selling_price: money,
    marketplace: z.preprocess((v) => (typeof blankToUndef(v) === 'string' ? (v as string).trim().toUpperCase() : blankToUndef(v)), z.enum(MARKETPLACE_CODES as [string, ...string[]]).optional()),
    marketplace_sku: str(64),
  })
  .superRefine((row, ctx) => {
    if (row.ships_from && !row.supplier) ctx.addIssue({ code: 'custom', path: ['supplier'], message: 'Supplier is required when ships-from is given' });
    if (row.cost !== undefined && !row.currency) ctx.addIssue({ code: 'custom', path: ['currency'], message: 'Currency is required when a cost is given' });
    if (row.selling_price !== undefined && !row.marketplace) ctx.addIssue({ code: 'custom', path: ['marketplace'], message: 'Marketplace is required when a selling price is given' });
    if (row.marketplace_sku && !row.marketplace) ctx.addIssue({ code: 'custom', path: ['marketplace'], message: 'Marketplace is required when a marketplace SKU is given' });
  });

export type ImportRow = z.infer<typeof ImportRowSchema>;

export interface RowValidation {
  rowNumber: number;
  ok: boolean;
  data?: ImportRow;
  errors: Array<{ field: string; message: string }>;
}

export function mapAndValidateRow(raw: Record<string, unknown>, mapping: Partial<Record<ImportField, string>>, rowNumber: number): RowValidation {
  const mapped: Record<string, unknown> = {};
  for (const [field, header] of Object.entries(mapping)) if (header) mapped[field] = raw[header];
  const r = ImportRowSchema.safeParse(mapped);
  if (r.success) return { rowNumber, ok: true, data: r.data, errors: [] };
  return {
    rowNumber,
    ok: false,
    errors: r.error.issues.map((i) => ({ field: i.path.join('.') || 'row', message: i.message })),
  };
}

/** Detect duplicate SKUs (or SKU + marketplace pairs) within one file. */
export function findDuplicateRows(rows: RowValidation[]): Map<number, string> {
  const seen = new Map<string, number>();
  const dups = new Map<number, string>();
  for (const r of rows) {
    if (!r.ok || !r.data) continue;
    const key = `${r.data.sku.toLowerCase()}|${r.data.marketplace ?? ''}`;
    if (seen.has(key)) dups.set(r.rowNumber, `Duplicate of row ${seen.get(key)} (same SKU${r.data.marketplace ? ' and marketplace' : ''})`);
    else seen.set(key, r.rowNumber);
  }
  return dups;
}

export const IMPORT_TEMPLATE_HEADERS: ImportField[] = [
  'product_id', 'parent_sku', 'sku', 'title', 'description', 'category', 'brand', 'barcode', 'size', 'colour', 'material', 'weight_g',
  'supplier', 'supplier_url', 'supplier_sku', 'supplier_product_id', 'ships_from', 'cost', 'supplier_shipping', 'packaging', 'currency',
  'fulfilment_model', 'stock', 'safety_stock', 'selling_price', 'marketplace', 'marketplace_sku',
];
