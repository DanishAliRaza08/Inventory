# 4. Marketplace integration & API permissions matrix

Code: `apps/api/src/integrations/` — `connector.ts` (interface + result types), `connectors.ts`
(per-marketplace capability tables), `connector-registry.ts`. The live capability matrix is served
at `GET /api/integrations/capabilities`.

## 4.1 Ground rules

* **Official APIs only.** No browser automation, scraping or unofficial endpoints.
* **Verify before trusting.** Each operation below is mapped to the official API that documents
  it. Operations are **built** when implemented and tested against the mock marketplace server
  (`apps/api/src/mock`, which reproduces each API's request format, signatures and responses);
  they become **verified** after a successful run against Fashion Rockstar's real account —
  sandbox first where the marketplace offers one, then production with a low-risk listing.
* **Honest status.** An operation that is not implemented returns
  `CONNECTOR_NOT_IMPLEMENTED` with a readable explanation. An operation without an API is
  labelled `manual`. Nothing is shown as published unless the marketplace confirmed it.
* **Demo mode is separate.** The `DemoConnector` only runs when `DEMO_MODE=true` (refused in
  production) **and** the account's environment is `DEMO`; its ids are prefixed `DEMO-`.
* **Credentials** (OAuth refresh/access tokens, client secrets) are encrypted with AES-256-GCM in
  `integration_credentials`, decrypted only inside the worker, and never returned by any API or
  sent to the browser. Token refresh runs before expiry; an expired or revoked grant sets the
  account to `EXPIRED` and shows a **Reconnect** action.

Status legend: **V** verified against the live marketplace · **B** built (tested against the mock
marketplace; awaiting real credentials) · **M** manual · **U** unsupported.
Current status for every row below: **B**. Tests: `apps/api/test/connectors.test.ts`.

**Mock mode.** `MOCK_MARKETPLACES=true` (refused in production) points every connector at the mock
server (`pnpm --filter @fr/api mock`, default `:4100`) and fills in dummy app credentials, so the
whole OAuth → publish → orders → tracking → fees → settlement flow runs end-to-end with dummy
data. The mock checks TikTok and AliExpress request signatures and keeps state in memory
(`POST /mock/reset`, `POST /mock/:marketplace/orders` to generate orders, `GET /mock/state`).

## 4.2 eBay UK (`EBAY_GB`) and eBay USA (`EBAY_US`)

Two separate marketplace contexts: different site, currency (GBP/USD), business policies,
categories, item specifics and fee schedules. One OAuth app can serve both, but each account
connection, policy set and listing is stored per context.

> **Decision (October 2026): keep managing eBay listings the existing way.** Listing operations use
> the **Trading API**, so every listing — existing and new — stays editable in Seller Hub and no
> listing is migrated to the Inventory API (that migration is one-way and Inventory API listings
> can no longer be edited in Seller Hub). Existing listings are adopted into the platform from
> eBay's own data. REST APIs are used only where they don't change how listings are managed.

| Operation | Official API | Notes to verify |
|---|---|---|
| Connect account | OAuth 2.0 authorization code grant (user access + refresh token); the OAuth user token is accepted by the Trading API | Production keyset requires eBay developer program approval; subscribe to (or opt out of) **marketplace account deletion notifications**, required for all apps |
| Categories | Commerce **Taxonomy API** `getCategoryTree`, `getCategorySuggestions` | per site |
| Item specifics | Taxonomy API `getItemAspectsForCategory` | cached per category → `requiredAttributes` |
| Business policies | **Account API** `getFulfillmentPolicies` / `getReturnPolicies` / `getPaymentPolicies` | policy profile ids are used in Trading API `SellerProfiles` |
| **Adopt existing listings** | **Trading API** `GetSellerList` / `GetMyeBaySelling` + `GetItem` | Imports live Seller Hub listings as `ACTIVE` (confirmed by eBay's data, never by hand), linking them to master SKUs by Custom Label (SKU); unmatched listings go to a review queue |
| Create listing | Trading API `VerifyAddFixedPriceItem` → `AddFixedPriceItem` | the Verify call is the pre-approval check; returns the ItemID |
| Revise listing | Trading API `ReviseFixedPriceItem` | only the fields that changed are sent, so marketplace-only settings made in Seller Hub are not overwritten |
| Price & quantity | Trading API `ReviseInventoryStatus` (up to 4 items per call) | |
| Pause | `ReviseInventoryStatus` quantity 0 with out-of-stock control | eBay fixed-price listings have no "pause" state |
| End | Trading API `EndFixedPriceItem` | |
| Status | Trading API `GetItem` | |
| Orders | **Fulfillment API** `getOrders` | buyer details encrypted; Order Manager role only |
| Tracking | Fulfillment API `createShippingFulfillment` | dispatch only after carrier/supplier confirmation |
| Returns | **Post-Order API** | verify availability for the UK/US accounts |
| Fees & payouts | **Finances API** `getTransactions`, `getPayouts` | **digital signatures** required for UK/EU sellers |
| Notifications | Trading API platform notifications (`ItemListed`, `ItemRevised`, `FixedPriceTransaction`…) | scheduled reconciliation as fallback |

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
| Adopt existing listings | Reports API `GET_MERCHANT_LISTINGS_ALL_DATA` + `getListingsItem` | Product Listing | links existing offers to master SKUs by seller SKU |
| Orders | **Orders API** `getOrders`, `getOrderItems` | Inventory and Order Tracking | buyer name/address via a **Restricted Data Token** (Tokens API) |
| Tracking | Orders API `confirmShipment` | Direct-to-Consumer Shipping | |
| Fees | **Finances API** `listFinancialEvents` (by order / group) | Finance and Accounting | |
| Settlements | **Reports API** settlement report (`GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2`) | Finance and Accounting | settlement → `confirmed` profit |
| Returns | Reports API returns reports | per report | |
| Notifications | **Notifications API** (SQS / EventBridge destinations) | — | |

### Amazon self-fulfilment (decision October 2026)

Fashion Rockstar ships Amazon orders itself (merchant-fulfilled), so the app needs Amazon's
**restricted Direct-to-Consumer Shipping role** to read buyer names and addresses. Amazon grants it
only after reviewing the developer profile against its **Data Protection Policy (DPP)** and
Acceptable Use Policy. What the platform already does for that review:

| DPP expectation | How it is met |
|---|---|
| PII used only for fulfilment, minimum necessary | Only name, address, phone/email needed for shipping are stored, in `order_customers` |
| Encryption at rest and in transit | Each PII field AES-256-GCM encrypted by the application (on top of database/disk encryption); HTTPS only |
| Retention: delete within 30 days after delivery | `privacy.amazon_pii_retention_days_after_delivery` (max 30, enforced); clock restarts at delivery; hourly purge job; purge is audited |
| Access control | Only `orders.customer_pii` (Order Manager, Owner); individual accounts, MFA for privileged roles |
| Logging & monitoring | Every PII read is written to the append-only audit log |
| Incident response | Security incidents involving Amazon data must be reported to Amazon within 24 hours — process in `docs/09-deployment.md` |
| No PII in logs, exports or the browser cache beyond the order screen | PII is excluded from exports and API logs |

Still needed from Fashion Rockstar before applying: a written security/incident policy, and
confirmation of where the platform is hosted (Amazon asks for the hosting provider and its
encryption/backup arrangements).

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

Code: `apps/api/src/integrations/supplier-connectors.ts` (capabilities shown on the Integrations page).

| Supplier | Integration | Use |
|---|---|---|
| AliExpress | **Official AliExpress Open Platform dropshipping (DS) APIs** (decision October 2026): `aliexpress.ds.product.get` (price, stock, ship-from), `aliexpress.ds.order.create`, `aliexpress.ds.order.tracking.get`. HMAC-SHA256 signed requests, seller OAuth (`/api/integrations/oauth/aliexpress/callback`) | **B**. Needs the approved app's key and secret (`ALIEXPRESS_APP_KEY/SECRET`). Without them AliExpress stays manual: price/stock checks recorded with source and time |
| CJ Dropshipping | Official CJ API v2 (`CJ-Access-Token` from the API key): product/variant query, inventory per warehouse, `createOrderV2`, tracking | **B**. Needs `CJ_API_KEY` |
| Others | CSV/XLSX price & stock files, manual entry | now |

Supplier orders are **never placed automatically**: a staff member confirms each one. Supplier-
reported stock is a signal, never owned inventory (see document 7). The supplier's
**ships-from country** (per supplier, overridable per SKU, filled from the API when available)
drives the UK low-value import VAT rule (document 5).

## 4.6 Error handling contract (all connectors)

Every call writes `marketplace_operations`: operation, account, entity, timestamp, status
(`SUCCEEDED`, `FAILED_TRANSIENT`, `FAILED_PERMANENT`, `UNSUPPORTED`), marketplace error code, raw
message, **readable explanation**, retry count, HTTP status, duration and **next action**.
Transient errors (timeouts, 429, 5xx) are retried with exponential backoff and jitter up to
`max_attempts` (default 5); permanent validation errors are never retried automatically. Rate
limits are respected per marketplace/endpoint with a token-bucket limiter in the worker.
Reconciliation jobs compare marketplace state (listings, quantities, orders) with the database and
raise discrepancies.
