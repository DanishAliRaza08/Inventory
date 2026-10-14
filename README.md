# Fashion Rockstar LTD — Multi-channel Operations Platform

Inventory, listings, orders and profit for eBay UK, eBay USA, Amazon UK and TikTok Shop UK, with
AliExpress, CJ Dropshipping and manual suppliers.

```
packages/core   Pure domain logic: money & FX, fee rules, profit, reverse pricing, listing
                lifecycle & validation, inventory availability & sync planning, import schema
apps/api        NestJS + Prisma + PostgreSQL + BullMQ — REST API (OpenAPI), background worker,
                marketplace/supplier connectors, mock marketplace server, demo data generator
apps/web        Next.js + Tailwind admin web app
e2e             Playwright end-to-end tests
docs            Architecture and design documents
```

## Status

Everything in the brief is built and tested against **dummy data**: a mock marketplace server
that speaks the real eBay, Amazon, TikTok Shop, AliExpress and CJ API formats (including request
signatures), and a demo business with 90 days of orders. What is left is **your accounts and
keys** — see [What you need to provide](#what-you-need-to-provide). Each marketplace operation is
marked **built** (tested against the mock) and becomes **verified** after its first successful
run with your real credentials.

| Area | What it does |
|---|---|
| Access & security | Staff accounts, argon2id, server-side sessions, TOTP MFA, lockout, CSRF, 7 roles + custom roles, permission checks on every call, append-only audit log, encrypted tokens |
| Catalogue | Permanent product numbers, variations, unique SKUs + aliases, images, search, duplicates, bulk edit, saved views |
| Suppliers & costs | AliExpress (official DS API) / CJ (API v2) / manual suppliers, backups, price history, effective-dated landed costs, cost-increase alerts |
| Inventory | Physical stock buckets with idempotent movements (never negative, no overselling) kept separate from supplier-reported stock; pushed to marketplaces on change |
| Listings | Templates, versions, validation, submit → approve → publish, bulk operations, category attributes from the marketplace, emergency stop. **Active only after the marketplace confirms** |
| Orders | Unified orders from all 4 marketplaces, SKU matching, supplier-order checklist and staff-confirmed supplier ordering, tracking sent to the marketplace (dispatched only once accepted), delivery, returns, refunds |
| Profit & finance | Decimal-exact line profit, VAT / US sales tax, UK low-value import rule, fee rules → replaced by actual fees, settlements, refunds, FX, expenses; estimated / partially reconciled / confirmed |
| Repricing | Live listings below break-even or target margin, proposed prices, apply after approval |
| Reports | 16 reports (sales/profit by marketplace, SKU, category, supplier, order; low margin; best sellers; slow stock; fees actual vs estimated; refunds; monthly operating profit …) with CSV/XLSX export |
| Listing templates | Per-marketplace title/description/bullet templates with a live preview against a real SKU; missing facts are left out, never invented |
| Image checks | Each image checked (Claude vision) for added text/watermarks, borders/collages and — for Amazon main images — a white background; problems on the main image block approval, others are warnings |
| Scale | Load tested at 20k products / 100k listings / 100k orders a month ([docs/08 §8.6](docs/08-delivery-plan-and-testing.md)) |
| Automation | Scheduled rules (low margin, supplier out of stock, price rises, dispatch deadlines, failures, stale data, daily summary) with run logs; live-affecting actions approval-gated |
| AI assistant | Listing title/description/bullets/keywords and buyer-reply drafts from verified facts only (Claude API). Never applied or sent automatically |
| Privacy | Customer data encrypted per field, every view audited, Amazon data deleted ≤ 30 days after delivery |
| Imports/exports | CSV/XLSX wizard with mapping, validation, preview, background import (5,000+ rows), error download |

## Business decisions applied (October 2026)

* **VAT:** the UK low-value import rule is applied automatically per order line from each supplier's
  ships-from country (overseas goods ≤ £135 → the marketplace accounts for VAT).
* **eBay:** existing listings are kept and managed via the Trading API ("Import existing listings"
  adopts them; nothing is migrated).
* **AliExpress:** official AliExpress dropshipping API.
* **Amazon:** orders are shipped by Fashion Rockstar; buyer data is encrypted, every read audited
  and deleted no later than 30 days after delivery.

## Try it with dummy data (no accounts needed)

Needs Node 20+, pnpm, PostgreSQL 16 and Redis (`docker compose up -d` starts both).

```bash
pnpm install && pnpm --filter @fr/core build && pnpm --filter @fr/api prisma:generate
cp apps/api/.env.example apps/api/.env
#   set APP_ENCRYPTION_KEY (command in the file), SEED_OWNER_EMAIL, SEED_OWNER_PASSWORD
#   set DEMO_MODE=true and QUEUE_MODE=inline
pnpm db:migrate && pnpm db:seed
pnpm --filter @fr/api demo          # ~2 min: 150 SKUs, ~500 listings, ~800 orders over 90 days
pnpm dev:api                        # http://localhost:4000 (Swagger at /api/docs)
pnpm dev:web                        # http://localhost:3000 — sign in with SEED_OWNER_*
```

Demo accounts are labelled **(DEMO)** and never contact a marketplace; demo fee rates are examples.

To exercise the **real connector code** against the mock marketplaces (OAuth redirects, publishing,
order import, tracking, fees, supplier sync), also set `MOCK_MARKETPLACES=true` and run:

```bash
pnpm --filter @fr/api mock          # mock eBay/Amazon/TikTok/AliExpress/CJ on :4100
```

Then use **Integrations → Connect** on the non-demo accounts. Neither demo nor mock mode can be
enabled when `NODE_ENV=production`.

## What you need to provide

Put these in the API server's environment (`apps/api/.env` locally, your host's secret store in
production). **Never commit them or paste them into chat.** After adding them, set
`MOCK_MARKETPLACES=false` and `DEMO_MODE=false` and restart the API and the worker.

### 1. Server basics

| Variable | What | Where to get it |
|---|---|---|
| `DATABASE_URL`, `REDIS_URL` | Managed PostgreSQL 16 and Redis | Your host (e.g. AWS RDS / ElastiCache, Render, Railway) |
| `APP_ENCRYPTION_KEY` | 32 random bytes, base64 — encrypts tokens, MFA secrets and customer data. **Back it up**; losing it means reconnecting every account | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `PUBLIC_BASE_URL` | Public **HTTPS** URL of the API, e.g. `https://ops.fashionrockstar.co.uk` | Your domain. Marketplaces redirect here after sign-in and download listing images from here |
| `WEB_ORIGIN` | URL of the web app | Your domain |
| `NODE_ENV=production`, `MFA_ENFORCE_FOR_PRIVILEGED=true`, `QUEUE_MODE=bullmq` | Production settings | — |
| `API_WORKERS` | API processes sharing the port — set to the number of CPU cores | Your server size |
| `AGGREGATE_CACHE_SECONDS` | How long dashboard/report figures are cached (default 60; 0 = always live) | Optional |
| `SEED_OWNER_EMAIL`, `SEED_OWNER_PASSWORD` | First owner login (first run only) | You choose |

Build with `pnpm --filter @fr/api build`, then run **two processes**: the API
(`pnpm --filter @fr/api start`) and the worker (`pnpm --filter @fr/api worker`)
— the worker runs order/fee/stock/supplier syncs, automation rules and data retention. Details:
[docs/09](docs/09-deployment.md).

### 2. eBay UK + eBay USA (one developer app)

| Variable | Where |
|---|---|
| `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` | [developer.ebay.com](https://developer.ebay.com) → Application Keys → **Production** keyset (use the Sandbox keyset with `EBAY_ENV=sandbox` to test first) |
| `EBAY_RU_NAME` | Application Keys → User Tokens → *Get a Token from eBay via Your Application* → add a RuName whose **auth accepted URL** is `<PUBLIC_BASE_URL>/api/integrations/oauth/ebay/callback` |
| `EBAY_ENV` | `production` when ready |
| `EBAY_SIGNING_KEY_JWE`, `EBAY_SIGNING_PRIVATE_KEY` | Required by eBay for Finances API calls from UK/EU sellers: create an **Ed25519** key with eBay's Key Management API (`POST /developer/key_management/v1/signing_key`) and paste the returned `jwe` and the PEM private key |

Then in the app: **Integrations → eBay UK (main) → Connect**, sign in with the eBay seller account,
repeat for eBay USA. Open **Settings** on each account and enter the item-location **postcode**,
town, country and default **payment policy ID** (Seller Hub → Business policies). Shipping and
return policy IDs are set per listing or template. Finally press **Import existing listings** to
adopt your current eBay listings.

### 3. Amazon UK (Selling Partner API)

1. Register as a developer in Seller Central → Apps & Services → **Develop apps**, and create an
   SP-API app with these roles: **Product Listing, Pricing, Inventory and Order Tracking, Amazon
   Fulfilment (self-ship), Finance and Accounting, Selling Partner Insights**, and the restricted
   role **Direct-to-Consumer Shipping** — needed to receive buyer names/addresses because you ship
   orders yourself. Amazon reviews the restricted role and asks how data is protected; the answers
   match [docs/06](docs/06-roles-and-permissions.md) (encryption, audited access, deletion ≤ 30 days
   after delivery).
2. Set `AMAZON_LWA_CLIENT_ID`, `AMAZON_LWA_CLIENT_SECRET` (the app's LWA credentials) and
   `AMAZON_SP_APP_ID` (the app ID, `amzn1.sp.solution…`). Add
   `<PUBLIC_BASE_URL>/api/integrations/oauth/amazon/callback` as the app's OAuth redirect URI.
3. In the app: **Integrations → Amazon UK (main) → Connect** — or, for a private self-authorised
   app, **Self-authorised…** and paste the seller ID and refresh token (stored encrypted).
4. **Settings**: seller ID and default **product type** (e.g. `DRESS`).

### 4. TikTok Shop UK

| Variable | Where |
|---|---|
| `TIKTOK_APP_KEY`, `TIKTOK_APP_SECRET`, `TIKTOK_SERVICE_ID` | [partner.tiktokshop.com](https://partner.tiktokshop.com) → create a **Custom app** for the UK market with Product, Order, Fulfilment, Logistics and Finance scopes; set the redirect URL to `<PUBLIC_BASE_URL>/api/integrations/oauth/tiktok/callback` |

Then **Integrations → TikTok Shop UK (main) → Connect**, and in **Settings** enter the
**warehouse ID** and the **shipping provider IDs** for the carriers you use (Seller Center →
Shipping). New products go through TikTok's audit; they show *Publishing* until approved.

### 5. Suppliers

| Variable | Where |
|---|---|
| `ALIEXPRESS_APP_KEY`, `ALIEXPRESS_APP_SECRET` | [openservice.aliexpress.com](https://openservice.aliexpress.com) → apply for the **Dropshipping** solution; callback URL `<PUBLIC_BASE_URL>/api/integrations/oauth/aliexpress/callback`. Then **Suppliers → your AliExpress supplier → Connect** |
| `CJ_API_KEY` | CJ Dropshipping → My CJ → Authorization → API → generate key. Then **Suppliers → CJ → Connect** |

For each supplier set the **ships-from country** (drives the VAT rule) and on each supplier SKU the
supplier product ID / SKU so price and stock sync can find it.

### 6. AI assistant (optional)

`ANTHROPIC_API_KEY` from [console.anthropic.com](https://console.anthropic.com). Used for listing copy, buyer-reply drafts and image checks (the worker checks new images every 30 minutes). `AI_MODEL`
defaults to `claude-opus-5-5`. Without a key the AI buttons say the assistant is not configured (in demo/mock mode they return
facts-only demo suggestions instead).

### 7. Business settings to enter in the app (not secrets)

* **Fee rules** (Costs & Expenses → Fee rules): your real eBay/Amazon/TikTok rates by category —
  delete the DEMO rules. Actual fees replace estimates once the finance sync imports them.
* **Exchange rates** (Costs & Expenses → Exchange rates): USD→GBP and any other supplier currency.
* **Settings → finance**: VAT registration, VAT rate, target margin, reporting currency;
  **privacy** retention days.
* **Costs** for every SKU (import template supports this), supplier links, physical stock counts.
* **Users**: invite staff and assign roles; owners/approvers/finance must enrol MFA.
* **Automation rules**: review thresholds and enable the ones you want.

## Tests

```bash
pnpm test:core                         # 66 unit tests (money, fees, VAT, profit, lifecycle, inventory)
TEST_DATABASE_URL=… pnpm test:api      # 87 integration tests on PostgreSQL, incl. every connector vs the mock
pnpm --filter @fr/e2e test:e2e         # browser journey (stack running with DEMO_MODE=true)
```

Load test (empty, non-production database): `pnpm --filter @fr/api load:data`, start the API on that
database, then `LOAD_EMAIL=… LOAD_PASSWORD=… pnpm --filter @fr/api load:test`. Results: docs/08 §8.6.

## Design documents

1. [Architecture & technology decisions](docs/01-architecture.md)
2. [Front-end page structure & wireframes](docs/02-frontend-structure.md)
3. [Database schema & entity relationships](docs/03-database-schema.md)
4. [Marketplace integration & API permissions matrix](docs/04-marketplace-integrations.md)
5. [Profit calculation specification](docs/05-profit-calculation.md)
6. [User roles & permissions matrix](docs/06-roles-and-permissions.md)
7. [Listing lifecycle & inventory synchronisation](docs/07-listing-lifecycle-and-inventory-sync.md)
8. [Delivery plan, testing strategy & acceptance status](docs/08-delivery-plan-and-testing.md)
9. [Deployment & operations](docs/09-deployment.md)
10. [OpenAPI document](docs/openapi.json)
