# 4. Marketplace integration & API permissions matrix

Code: `apps/api/src/integrations/` — `connector.ts` (interface + result types), `connectors.ts`
(per-marketplace capability tables), `connector-registry.ts`. The live capability matrix is served
at `GET /api/integrations/capabilities`.

## 4.1 Ground rules

* **Official APIs only.** No browser automation, scraping or unofficial endpoints.
* **Verify before building.** Each operation below is mapped to the official API that documents
  it. Before an operation is switched from `planned` to `implemented` it must be verified for
  Fashion Rockstar's account, region and approval status, and tested against the sandbox (where
  the marketplace offers one) and then production with a low-risk listing.
* **Honest status.** An operation that is not yet implemented returns
  `CONNECTOR_NOT_IMPLEMENTED` with a readable explanation. An operation without an API is
  labelled `manual`. Nothing is shown as published unless the marketplace confirmed it.
* **Demo mode is separate.** The `DemoConnector` only runs when `DEMO_MODE=true` (refused in
  production) **and** the account's environment is `DEMO`; its ids are prefixed `DEMO-`.
* **Credentials** (OAuth refresh/access tokens, client secrets) are encrypted with AES-256-GCM in
  `integration_credentials`, decrypted only inside the worker, and never returned by any API or
  sent to the browser. Token refresh runs before expiry; an expired or revoked grant sets the
  account to `EXPIRED` and shows a **Reconnect** action.

Status legend: **I** implemented · **P** planned (official API exists) · **M** manual · **U** unsupported.
Current status for every row: **P**, connector work begins in Phase 3.

## 4.2 eBay UK (`EBAY_GB`) and eBay USA (`EBAY_US`)

Two separate marketplace contexts: different site, currency (GBP/USD), business policies,
categories, item specifics and fee schedules. One OAuth app can serve both, but each account
connection, policy set and listing is stored per context.

| Operation | Official API (REST unless noted) | OAuth scope (user token) | Notes to verify |
|---|---|---|---|
| Connect account | OAuth 2.0 authorization code grant; refresh token | — | Production keyset requires eBay developer program approval; subscribe to (or opt out of) **marketplace account deletion notifications**, which eBay requires for all apps |
| Categories | Commerce **Taxonomy API** `getDefaultCategoryTreeId`, `getCategorySuggestions`, `getCategoryTree` | application token | per marketplace id |
| Item specifics | Taxonomy API `getItemAspectsForCategory` | application token | cached per category → `requiredAttributes` |
| Business policies | **Account API** `getFulfillmentPolicies`, `getReturnPolicies`, `getPaymentPolicies` | `sell.account` | account must be opted in to business policies |
| Create listing | **Inventory API** `createOrReplaceInventoryItem` → `createOffer` → `publishOffer` | `sell.inventory` | requires an inventory location (`createInventoryLocation`); `publishOffer` returns the listing id; idempotent by SKU |
| Revise listing | `createOrReplaceInventoryItem` / `updateOffer` | `sell.inventory` | |
| Price & quantity | `bulkUpdatePriceQuantity` | `sell.inventory` | batches of up to 25 |
| Pause | quantity → 0 with out-of-stock control | `sell.inventory` / `sell.account` | eBay fixed-price listings have no "pause" state |
| End | `withdrawOffer` | `sell.inventory` | |
| Existing Seller Hub listings | `bulkMigrateListing` | `sell.inventory` | Listings created outside the Inventory API must be migrated before the Inventory API can manage them — **decide before go-live** (migration is one-way) |
| Orders | **Fulfillment API** `getOrders` | `sell.fulfillment` | buyer address restricted to Order Manager role |
| Tracking | Fulfillment API `createShippingFulfillment` | `sell.fulfillment` | dispatch only after carrier/supplier confirmation |
| Returns | **Post-Order API** (returns, cancellations) | per Post-Order docs | verify availability for the UK/US accounts |
| Fees & payouts | **Finances API** `getTransactions`, `getPayouts` | `sell.finances` | eBay requires **digital signatures** on Finances API calls for some (incl. UK/EU) sellers — verify and implement signing |
| Notifications | Platform / Notification API topics | — | webhook where available, scheduled reconciliation as fallback |

## 4.3 Amazon UK (marketplace id `A1F83G8C2ARO7P`) — Selling Partner API

| Operation | SP-API | Role(s) required | Notes to verify |
|---|---|---|---|
| Connect account | Self-authorised private app or app authorisation workflow; Login with Amazon refresh token | — | Register as SP-API developer; select roles below |
| Product type / attributes | **Product Type Definitions API** `searchDefinitionsProductTypes`, `getDefinitionsProductType` (JSON Schema) | Product Listing | schema drives required attributes per product type |
| Catalogue match | **Catalog Items API** `searchCatalogItems` | Product Listing | match existing ASIN by GTIN before creating new |
| Create / update listing | **Listings Items API** `putListingsItem` / `patchListingsItem` (supports `mode=VALIDATION_PREVIEW`) | Product Listing | **Amazon has no hosted draft**; drafts exist only in this platform. Use validation preview before approval |
| Bulk | **Feeds API** `JSON_LISTINGS_FEED` | Product Listing | for large batches; processing reports give per-SKU results |
| Price & quantity | `patchListingsItem` (`purchasable_offer`, `fulfillment_availability`) | Pricing; Inventory and Order Tracking | |
| Pause / delete | quantity 0 / `deleteListingsItem` | Product Listing | |
| Listing issues | `getListingsItem` (issues, status); `LISTINGS_ITEM_ISSUES_CHANGE` notification | Product Listing | |
| Orders | **Orders API** `getOrders`, `getOrderItems` | Inventory and Order Tracking | buyer PII needs the restricted **Direct-to-Consumer Shipping** role and a **Restricted Data Token** (Tokens API) |
| Tracking | Orders API `confirmShipment` (or order fulfillment feed) | Direct-to-Consumer Shipping | |
| Fees | **Finances API** `listFinancialEvents` (by order / group) | Finance and Accounting | |
| Settlements | **Reports API** settlement report (`GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2`) | Finance and Accounting | settlement → `confirmed` profit |
| Returns | Reports API returns reports | per report | |
| Notifications | **Notifications API** (SQS / EventBridge destinations) | — | |

## 4.4 TikTok Shop UK — TikTok Shop Open API (Partner Center)

| Operation | API | Notes to verify |
|---|---|---|
| Connect account | App authorisation via TikTok Shop Partner Center; access + refresh tokens; signed requests (HMAC-SHA256 with app secret) | App must be approved for the UK region and required scopes |
| Categories & rules | Product API: get categories, get attributes, get category rules, get brands | category rules include required certifications/qualifications |
| Images | Product API: upload product image | images are uploaded to TikTok before product creation |
| Create / edit product | Product API: create product, edit / partial edit product | products go through **TikTok audit**; the connector must keep the listing in `PUBLISHING` until audit passes and only then confirm `ACTIVE` (failure reasons → `PUBLICATION_FAILED`) |
| Price & inventory | Product API: update price, update inventory | |
| Pause / end | Product API: deactivate / delete products | |
| Orders | Order API: get order list / get order detail | |
| Fulfilment | Fulfillment API: ship package / update tracking | |
| Returns & refunds | Return and Refund API | |
| Fees & settlement | Finance API: statements, statement / order transactions | |
| Webhooks | Order status, product audit status, return status | reconciliation polling as fallback |

API versions (e.g. `202309`) change; pin the version per endpoint and track deprecation notices.

## 4.5 Suppliers

| Supplier | Integration | Use |
|---|---|---|
| CJ Dropshipping | Official CJ API (product, variant stock, order creation, tracking) | stock & price checks, optional order placement, tracking retrieval — Phase 4 |
| AliExpress | Official AliExpress Open Platform APIs (dropshipping) **only if the account is approved**; otherwise manual | otherwise: manual price/stock checks recorded with source + timestamp, manual ordering checklist |
| Others | CSV/XLSX price & stock files, manual entry | |

Supplier-reported stock is treated as a signal, never as owned inventory (see document 7).

## 4.6 Error handling contract (all connectors)

Every call writes `marketplace_operations`: operation, account, entity, timestamp, status
(`SUCCEEDED`, `FAILED_TRANSIENT`, `FAILED_PERMANENT`, `UNSUPPORTED`), marketplace error code, raw
message, **readable explanation**, retry count, HTTP status, duration and **next action**.
Transient errors (timeouts, 429, 5xx) are retried with exponential backoff and jitter up to
`max_attempts` (default 5); permanent validation errors are never retried automatically. Rate
limits are respected per marketplace/endpoint with a token-bucket limiter in the worker.
Reconciliation jobs compare marketplace state (listings, quantities, orders) with the database and
raise discrepancies.
