# 5. Profit calculation specification

Implementation: `packages/core/src/profit.ts`, `fees.ts`, `costs.ts`, `fx.ts`, `pricing.ts`
(unit tests in `packages/core/test`). The API (`/api/profit/*`) and every report use this one engine.

## 5.1 Principles

1. **Decimal arithmetic only.** Amounts are `decimal.js` values; never JS floats.
2. **Every amount carries a currency.** Adding GBP to USD throws `CurrencyMismatchError`.
3. **No silent FX.** Converting needs a stored rate; a missing rate throws `MissingFxRateError`
   (the API returns HTTP 422). The rate, its timestamp and source are recorded on the result.
4. **Tax collected is never revenue.** VAT/sales tax is separated before revenue is counted.
5. **Actual beats estimate, and never adds to it.** When a marketplace reports actual fees for a
   line, they *replace* the estimated fee lines entirely.
6. **History is immutable.** Costs are effective-dated; an order uses the cost record in force at
   the time of sale (`costAt(records, soldAt)`), not today's supplier price.
7. **Display rounding is consistent.** Each line item is rounded to pennies first and net profit
   is the sum of the rounded lines, so the breakdown always adds up exactly.

## 5.2 Inputs per order line

| Group | Field | Notes |
|---|---|---|
| Sale | `unitPrice`, `quantity`, `shippingCharged`, `sellerDiscount` | as charged to the buyer; marketplace-funded promotions are *not* seller discounts |
| Tax | `pricesIncludeTax`, `taxTreatment`, `taxRatePercent`, `taxAmount` | marketplace-reported tax overrides the configured rate |
| Cost | effective-dated `CostRecord` (any currency) | supplier price, supplier shipping, packaging, import duty, non-recoverable tax, FX spread %, purchase payment %, other per-unit |
| Fees | `feeRules` (estimate) **or** `actualFees` (reconciled) | |
| Other | `fulfilmentCost`, `advertisingCost`, `otherExpenses` | attributable to the line |
| Refund | `amountRefunded`, `taxRefunded`, `returnShippingCost`, `feeCredit`, `recoveredStockValue` | |
| FX | `FxTable` + `reportingCurrency` | |

### Tax treatments

| `taxTreatment` | Meaning | Revenue |
|---|---|---|
| `seller_liable` | Fashion Rockstar is VAT-registered and owes the VAT in the price | price − VAT |
| `marketplace_collected` | The marketplace is the deemed supplier / marketplace facilitator and remits the tax | price − tax (tax is never seen as income) |
| `not_registered` | No tax separated | price |

Defaults (configurable in **Settings → Finance**): US marketplaces use tax-exclusive prices with
`marketplace_collected`. UK marketplaces use VAT-inclusive prices and the **UK low-value import
rule**, applied automatically per order line (decision October 2026, `finance.auto_low_value_import_vat`):

| Goods ship from | Consignment value (goods excl. VAT and shipping, in GBP) | Treatment |
|---|---|---|
| Outside the UK (supplier / SKU ships-from country ≠ GB) | ≤ £135 (`finance.low_value_import_threshold_gbp`) | `marketplace_collected` — the marketplace is the deemed supplier and accounts for the VAT |
| Outside the UK | > £135 | seller's own position (`seller_liable` if VAT registered, else `not_registered`); import VAT applies |
| UK (own physical stock, or a supplier/SKU marked GB, e.g. a CJ UK warehouse) | any | seller's own position |
| Unknown (no ships-from country set) | any | seller's own position, with a warning to set the country |

The resolved treatment and the reason are stored on every calculation (`taxTreatment`,
`taxTreatmentReason`) so VAT reports can separate sales the marketplace accounted for. Because VAT
is excluded from revenue in both treatments, profit is the same either way for a VAT-registered
seller; the rule decides **who owes the VAT**. Northern Ireland and EU destinations follow
different rules and are not covered. This is configurable behaviour, not tax advice — the
company's accountant remains responsible for the VAT position.

## 5.3 Formula

```
grossCharged      = (unitPrice × qty + shippingCharged − sellerDiscount)            [+ tax if prices exclude tax]
taxCollected      = taxAmount (reported) | derived from taxRatePercent | 0 (not registered)
netRevenue        = grossCharged − taxCollected

landedCostPerUnit = supplierPrice + supplierShipping
                  + (supplierPrice + supplierShipping) × (fxConversion% + purchasePayment%)
                  + packaging + importDuty + nonRecoverableTax + otherPerUnit
totalProductCost  = landedCostPerUnit × qty × fxRate(costCurrency → saleCurrency at soldAt)

feeLines          = actualFees  if any were imported
                    else evaluate(feeRules)          (see 5.4)
marketplaceFees   = Σ feeLines of type final_value, per_order, listing, regulatory, other
paymentFees       = Σ feeLines of type payment
fulfilmentCosts   = Σ feeLines of type fulfilment + fulfilmentCost
advertisingCosts  = Σ feeLines of type promoted, advertising + advertisingCost

netRefundCost     = (amountRefunded − refundTax) + returnShippingCost
                    − feeCredit (only when actual fees are NOT used; actual fees already contain credits)
                    − recoveredStockValue

netProfit         = netRevenue − totalProductCost − marketplaceFees − paymentFees
                    − fulfilmentCosts − advertisingCosts − otherExpenses − netRefundCost
netMargin%        = netProfit ÷ netRevenue × 100
returnOnCost%     = netProfit ÷ totalProductCost × 100
```

### Status of a figure

| Status | When |
|---|---|
| `estimated` | fees from configured rules |
| `partially_reconciled` | actual fees imported, settlement not yet received |
| `confirmed` | actual fees **and** marketplace settlement imported |

Every report states which statuses it contains; the dashboard shows estimated and confirmed profit
separately.

## 5.4 Fee rules

A fee rule has: marketplace, fee type, **basis** (`item_price`, `item_price_plus_shipping`,
`order_total_incl_tax`, `order_total_excl_tax`, `per_unit`, `per_order`), percentage *or*
progressive tiers, optional fixed amount, min/max caps, category filter, effective dates, and an
optional **override group**. Within a group the most specific matching rule wins (category-specific
beats generic), so category fees replace — not add to — the default selling fee.

No marketplace fee schedule is hard-coded. The operator enters the rates on their own account; the
demo data contains clearly labelled example rates only.

## 5.5 Demonstration example (spec §6)

| Item | Amount |
|---|---:|
| Net sales revenue | £25.00 |
| Product cost | £8.00 |
| Supplier shipping | £2.00 |
| Marketplace fees | £3.00 |
| Other expenses | £1.00 |
| **Net profit** | **£11.00** |
| **Net profit margin** | **44%** |

Reproduced by `simpleProfit` and by the full order-line engine in
`packages/core/test/profit.test.ts`, and by `POST /api/profit/simple` (response flagged
`demonstration: true`). These are demonstration values, not the company's costs or fee rates.

## 5.6 Reverse price calculator

`solveUnitPrice` finds the **lowest price to the penny** that achieves a target profit or margin by
bisection over the exact forward calculation, so tiered, capped and fixed fees, VAT and FX are all
honoured. Optional `.99` / `.49-or-.99` endings round *up* only. Break-even (minimum profitable
price) is the same solver with a target profit of 0. Impossible targets (≥100% margin, or
percentage fees ≥100%) are reported as not achievable.

## 5.7 Contribution vs operating profit

* **Contribution profit** = Σ order-line net profit.
* **Operating profit** = contribution profit − operating expenses (Expenses module) where
  `attributedToOrders = false`. An expense that is also charged at order level (e.g. postage
  already in `fulfilmentCost`) must be marked `attributedToOrders = true` and is then excluded
  from operating expenses, preventing double counting.
* Shared expenses can carry an allocation rule (`by_revenue`, `by_units`) for product-level
  reports; unallocated expenses (`none`) only affect business-level operating profit.

## 5.8 Alerts

Thresholds are settings, not code: minimum profit (default £3.00), minimum margin (15%), maximum
refund rate (10%), cost-verification age (30 days), supplier price increase (5%), unexpected fee
variance (15%). Alerts: negative profit, low profit, low margin, below minimum profitable price
(blocks listing approval), supplier price increase (notification on cost change), unexpected fees,
high refund rate, unverified costs.
