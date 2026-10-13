import { z } from 'zod';
import { zCurrency, zMoneyNonNeg, zPagination } from '../common/zod';

export const zSku = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._\-\/]+$/, 'SKU may only contain letters, digits and . _ - /');

export const VariantInput = z.object({
  sku: zSku,
  title: z.string().max(500).optional(),
  size: z.string().max(60).optional(),
  colour: z.string().max(60).optional(),
  material: z.string().max(120).optional(),
  barcode: z.string().max(14).optional(),
  weightGrams: z.number().int().nonnegative().optional(),
  lengthMm: z.number().int().nonnegative().optional(),
  widthMm: z.number().int().nonnegative().optional(),
  heightMm: z.number().int().nonnegative().optional(),
  attributes: z.record(z.string()).optional(),
  initialCost: z
    .object({
      currency: zCurrency,
      supplierPrice: zMoneyNonNeg,
      supplierShipping: zMoneyNonNeg.optional(),
      packaging: zMoneyNonNeg.optional(),
    })
    .optional(),
  initialStock: z.number().int().nonnegative().optional(),
});

export const CreateProduct = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().max(20000).default(''),
  category: z.string().max(200).optional(),
  brand: z.string().max(120).optional(),
  countryOfOrigin: z.string().max(80).optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'DISCONTINUED', 'ARCHIVED']).default('DRAFT'),
  fulfilmentModel: z.enum(['PHYSICAL', 'DROPSHIP']).default('DROPSHIP'),
  attributes: z.record(z.string()).default({}),
  restricted: z.boolean().default(false),
  variants: z.array(VariantInput).min(1, 'A product needs at least one SKU'),
});

export const UpdateProduct = CreateProduct.omit({ variants: true }).partial();
export const UpdateVariant = VariantInput.omit({ initialCost: true, initialStock: true }).partial().extend({
  status: z.enum(['DRAFT', 'ACTIVE', 'DISCONTINUED', 'ARCHIVED']).optional(),
});

export const ListProducts = zPagination.extend({
  search: z.string().trim().max(200).optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'DISCONTINUED', 'ARCHIVED']).optional(),
  category: z.string().optional(),
  brand: z.string().optional(),
  fulfilmentModel: z.enum(['PHYSICAL', 'DROPSHIP']).optional(),
  supplierId: z.string().uuid().optional(),
  marketplace: z.enum(['EBAY_UK', 'EBAY_US', 'AMAZON_UK', 'TIKTOK_UK']).optional(),
  unlisted: z.enum(['EBAY_UK', 'EBAY_US', 'AMAZON_UK', 'TIKTOK_UK']).optional(),
  stock: z.enum(['out', 'low', 'in']).optional(),
  sort: z.enum(['newest', 'oldest', 'title', 'number']).default('newest'),
});

export const BulkUpdate = z.object({
  productIds: z.array(z.string().uuid()).min(1).max(5000),
  patch: z
    .object({
      status: z.enum(['DRAFT', 'ACTIVE', 'DISCONTINUED', 'ARCHIVED']).optional(),
      category: z.string().max(200).optional(),
      brand: z.string().max(120).optional(),
      fulfilmentModel: z.enum(['PHYSICAL', 'DROPSHIP']).optional(),
      restricted: z.boolean().optional(),
    })
    .refine((p) => Object.keys(p).length > 0, 'Nothing to update'),
});

export const SkuAliasBulk = z.object({
  items: z
    .array(
      z.object({
        variantId: z.string().uuid(),
        type: z.enum(['MARKETPLACE', 'SUPPLIER', 'LEGACY']),
        scope: z.string().max(64).default(''),
        alias: zSku,
      }),
    )
    .min(1)
    .max(5000),
});
