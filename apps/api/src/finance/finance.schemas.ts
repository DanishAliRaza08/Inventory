import { FEE_BASES, FEE_TYPES, MARKETPLACE_CODES } from '@fr/core';
import { z } from 'zod';
import { zCurrency, zMoney, zMoneyNonNeg } from '../common/zod';

export const zCountry = z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z]{2}$/, 'Must be a 2-letter ISO country code'));

export const zMarketplace = z.enum(MARKETPLACE_CODES as ['EBAY_UK', 'EBAY_US', 'AMAZON_UK', 'TIKTOK_UK']);

export const FxRateInput = z.object({
  base: zCurrency,
  quote: zCurrency,
  rate: zMoneyNonNeg.refine((r) => Number(r) > 0, 'Rate must be positive'),
  asOf: z.coerce.date().default(() => new Date()),
  source: z.string().max(60).default('manual'),
});

export const FeeRuleInput = z.object({
  name: z.string().min(1).max(120),
  marketplace: zMarketplace,
  feeType: z.enum(FEE_TYPES),
  basis: z.enum(FEE_BASES),
  currency: zCurrency,
  percent: zMoneyNonNeg.optional(),
  tiers: z.array(z.object({ upTo: zMoneyNonNeg.optional(), percent: zMoneyNonNeg })).optional(),
  fixed: zMoney.optional(),
  minFee: zMoneyNonNeg.optional(),
  maxFee: zMoneyNonNeg.optional(),
  categoryIds: z.array(z.string()).default([]),
  overrideGroup: z.string().max(60).optional(),
  effectiveFrom: z.coerce.date().default(() => new Date()),
  effectiveTo: z.coerce.date().nullable().optional(),
  active: z.boolean().default(true),
  notes: z.string().max(2000).optional(),
});

const CostFields = z.object({
  currency: zCurrency,
  supplierPrice: zMoneyNonNeg,
  supplierShipping: zMoneyNonNeg.optional(),
  packaging: zMoneyNonNeg.optional(),
  importDuty: zMoneyNonNeg.optional(),
  nonRecoverableTax: zMoneyNonNeg.optional(),
  fxConversionPercent: zMoneyNonNeg.optional(),
  purchasePaymentPercent: zMoneyNonNeg.optional(),
  otherPerUnit: zMoneyNonNeg.optional(),
});

/** Free-form what-if calculation. Either reference a SKU (variantId) or give cost fields. */
export const CalculateInput = z
  .object({
    marketplace: zMarketplace,
    variantId: z.string().uuid().optional(),
    cost: CostFields.optional(),
    unitPrice: zMoneyNonNeg,
    quantity: z.number().int().positive().default(1),
    shippingCharged: zMoneyNonNeg.default('0'),
    sellerDiscount: zMoneyNonNeg.default('0'),
    categoryId: z.string().optional(),
    fulfilmentCost: zMoneyNonNeg.default('0'),
    advertisingCost: zMoneyNonNeg.default('0'),
    otherExpenses: zMoneyNonNeg.default('0'),
    /** Override tax handling for the calculation; defaults come from settings. */
    taxTreatment: z.enum(['seller_liable', 'marketplace_collected', 'not_registered']).optional(),
    taxRatePercent: zMoneyNonNeg.optional(),
    pricesIncludeTax: z.boolean().optional(),
    /** For manual-cost calculations: where the goods ship from (ISO country), for the UK import VAT rule. */
    shipsFromCountry: zCountry.nullable().optional(),
    reportingCurrency: zCurrency.optional(),
  })
  .refine((v) => v.variantId || v.cost, { message: 'Provide a variantId or cost fields', path: ['cost'] });

export const ReversePriceInput = CalculateInput.innerType()
  .omit({ unitPrice: true })
  .extend({
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('profit'), amount: zMoney }),
      z.object({ kind: z.literal('margin'), percent: zMoneyNonNeg }),
    ]),
    ending: z.enum(['none', '.99', '.49_or_.99']).default('none'),
  })
  .refine((v) => v.variantId || v.cost, { message: 'Provide a variantId or cost fields', path: ['cost'] });

export const SimpleProfitInput = z.object({
  netSalesRevenue: zMoney,
  productCost: zMoneyNonNeg,
  supplierShipping: zMoneyNonNeg,
  marketplaceFees: zMoneyNonNeg,
  paymentFees: zMoneyNonNeg.optional(),
  fulfilmentCosts: zMoneyNonNeg.optional(),
  advertisingCosts: zMoneyNonNeg.optional(),
  otherExpenses: zMoneyNonNeg.optional(),
  netRefundCosts: zMoneyNonNeg.optional(),
});

export const EXPENSE_CATEGORIES = ['SOFTWARE', 'ADVERTISING', 'ACCOUNTANCY', 'STORAGE', 'PACKAGING', 'RETURNS_HANDLING', 'BANK_CHARGES', 'STAFF', 'OTHER'] as const;

export const ExpenseInput = z.object({
  date: z.coerce.date(),
  category: z.enum(EXPENSE_CATEGORIES),
  description: z.string().min(1).max(500),
  amount: zMoneyNonNeg,
  currency: zCurrency,
  supplierId: z.string().uuid().optional(),
  marketplace: zMarketplace.optional(),
  notes: z.string().max(2000).optional(),
  allocation: z.enum(['none', 'by_revenue', 'by_units']).default('none'),
  attributedToOrders: z.boolean().default(false),
});
