# Fashion Rockstar LTD — Multi-channel Operations Platform

Inventory, profit and listing management for eBay UK, eBay USA, Amazon UK and TikTok Shop UK.

```
packages/core   Pure domain logic: money & FX, fee rules, profit, reverse pricing, listing
                lifecycle & validation, inventory availability & sync planning, import schema
apps/api        NestJS + Prisma + PostgreSQL + BullMQ — REST API (OpenAPI) and worker
apps/web        Next.js + Tailwind admin web app
e2e             Playwright end-to-end tests
docs            Architecture and design documents (start here)
```

## What works today (Phases 1–2 core)

* **Secure access:** individual staff accounts, argon2id passwords, revocable server-side sessions,
  TOTP multi-factor authentication, account lockout, CSRF protection, 7 default roles + custom roles,
  permissions enforced on every API call, append-only audit log.
* **Master catalogue:** permanent product numbers (`FRP-000123`), variations with case-insensitive
  unique SKUs, SKU aliases, images, global search, duplicate detection, bulk edit, saved views.
* **Suppliers & costs:** AliExpress / CJ / manual suppliers, backup suppliers, supplier price
  history, effective-dated landed costs (history never rewritten), cost-increase alerts, cost
  verification tracking.
* **Inventory:** physical stock buckets with idempotent, row-locked movements (no overselling,
  never negative) kept separate from supplier-reported dropship availability (buffered, expires
  when stale).
* **Profit:** decimal-exact order-line profit with VAT/sales-tax handling, fee rules (tiers,
  caps, category overrides), stored FX rates, refunds, estimated vs confirmed status,
  minimum profitable price and reverse price calculator; configurable alert thresholds.
* **Listings:** marketplace-specific drafts from templates, versioned content, validation
  (title limits, required fields/attributes, images, GTINs, promotional wording, unverified
  claims, below-break-even price, restricted products), submit → approve (separation of duties)
  → publish jobs with retries, readable errors and history; bulk drafts / approve / publish with a
  confirmation summary; emergency stop.
* **Imports/exports:** CSV/XLSX wizard (mapping, matching, duplicates, validation, preview,
  background import with progress, downloadable error rows, resumable); exports of products,
  listings and cost history.
* **Dashboard:** KPIs with date presets and marketplace filter, sales/profit charts, data
  freshness and completeness warnings.

## What is not built yet — and is not simulated

Marketplace connectors (OAuth, publishing, orders, fees, settlements) are **Phase 3–5**. Until
then, real marketplace accounts show *Not connected*, the capability matrix shows each operation as
*planned* with the official API it will use, and publishing to them is refused. A clearly labelled
**demo mode** (never allowed in production) uses a fake connector so the full workflow can be
exercised. Orders, returns, automation rules and the AI listing assistant are scheduled in
[docs/08](docs/08-delivery-plan-and-testing.md).

## Quick start

See [docs/09-deployment.md](docs/09-deployment.md). In short:

```bash
pnpm install && pnpm --filter @fr/core build && pnpm --filter @fr/api prisma:generate
cp apps/api/.env.example apps/api/.env   # set APP_ENCRYPTION_KEY, DATABASE_URL, SEED_OWNER_*
pnpm db:migrate && pnpm db:seed
pnpm dev:api   # :4000, Swagger at /api/docs
pnpm dev:web   # :3000
```

## Tests

```bash
pnpm test:core                         # 58 unit tests (financial, inventory, workflow logic)
TEST_DATABASE_URL=… pnpm test:api      # integration tests against real PostgreSQL
pnpm --filter @fr/e2e test:e2e         # browser journey (stack running with DEMO_MODE=true)
```

## Design documents

1. [Architecture & technology decisions](docs/01-architecture.md)
2. [Front-end page structure & wireframes](docs/02-frontend-structure.md)
3. [Database schema & entity relationships](docs/03-database-schema.md)
4. [Marketplace integration & API permissions matrix](docs/04-marketplace-integrations.md)
5. [Profit calculation specification](docs/05-profit-calculation.md)
6. [User roles & permissions matrix](docs/06-roles-and-permissions.md)
7. [Listing lifecycle & inventory synchronisation](docs/07-listing-lifecycle-and-inventory-sync.md)
8. [Phased plan, testing strategy & acceptance status](docs/08-delivery-plan-and-testing.md)
9. [Deployment & operations](docs/09-deployment.md)
10. [OpenAPI document](docs/openapi.json)
