# 8. Phased delivery plan, testing strategy & acceptance status

## 8.1 Phases and timeline (indicative, one senior full-stack developer + part-time QA)

| Phase | Scope | Duration | Status |
|---|---|---|---|
| 0 | Architecture, schema, design documents (this folder) | 1 week | **Done** |
| 1 — Foundation | Auth (sessions, argon2id, TOTP MFA), roles & custom roles, audit log, dashboard shell, master catalogue & SKUs, suppliers, effective-dated costs, FX, fee rules, profit & reverse-price calculators, CSV/XLSX import wizard & exports, emergency controls | 4–5 weeks | **Done** (this release) |
| 2 — Listing management | Listing builder, per-marketplace templates, versions, validation, approval workflow, image management, history, bulk drafts / approval / publish preview | 3–4 weeks | **Done**: builder, versions, validation, workflow, bulk operations, images, AI listing assistant (Claude API, suggestions only), category attributes loaded from the marketplace. **Not built:** template editor UI (templates via API), image text/watermark detection |
| 3 — Marketplace integrations | OAuth connect & token refresh per marketplace; categories & attributes; publish/revise/end; listing status; order retrieval; error handling; sandbox → production verification | 6–8 weeks (eBay UK/US 3, Amazon UK 2–3, TikTok UK 2) | **Built** against the mock marketplace (eBay Trading + REST, Amazon SP-API, TikTok Shop 202309). **Remaining:** verification with real credentials (see README → What you need to provide) |
| 4 — Inventory & orders | Order import & SKU matching, reservations, supplier availability polling (CJ API; AliExpress if approved), sync engine, fulfilment & tracking, returns & refunds | 4–5 weeks | **Built**: order sync, SKU matching, stock reservation/commit/ship, inventory push, supplier price/stock sync and staff-confirmed supplier orders (AliExpress DS, CJ), tracking push, delivery, returns, refunds, order screens |
| 5 — Financial reconciliation | Actual fees & settlements import, per-line confirmed profit, currency conversion service, expense allocation, reports | 3–4 weeks | **Built**: fee/refund/payout import per marketplace, estimated → partially reconciled → confirmed profit, fee variance alerts, 16 reports with CSV/XLSX export |
| 6 — Automation & optimisation | Automation builder, scheduled reports, repricing proposals with approval, low-margin monitoring, performance work | 3–4 weeks | **Built**: 8 rule kinds with run logs and approval gating, worker schedule, repricing proposals + approval. **Remaining:** load testing at full volume |

Each phase ends with a demo against its acceptance tests below, then deployment to staging, then
production behind the emergency controls.

## 8.2 Testing strategy

| Layer | Tool | What it proves | Where |
|---|---|---|---|
| Unit | Vitest | Profit engine (demo example, VAT, refunds, FX, actual-vs-estimated fees, rounding), fee rules (tiers, caps, overrides, dates), reverse pricing to the penny, listing state machine & guards, listing validation, physical/dropship availability, sync planning, import row validation | `packages/core/test` — **65 tests** |
| Integration | Vitest + Supertest against **real PostgreSQL** (migrations applied, DB truncated per file) | Auth/MFA/lockout/CSRF/permissions; catalogue & SKU uniqueness; cost history and DB constraints; supplier price → history + cost + alert; idempotent and concurrent stock movements (no overselling); profit API incl. FX refusal; full listing lifecycle through the job processor; failures, retries, kill switch, bulk preview tokens; 5,300-row import; exports | `apps/api/test` — **81 tests** |
| End-to-end | Playwright (Chromium) against running API + web with demo seed | Sign-in redirect, dashboard warnings, product creation → image upload → draft → second-user approval → publish (demo connector) → Active, profit demo example, integrations honesty, phone-width layout | `e2e/tests` — **6 tests** |
| Connector contract | Vitest against the mock marketplace server (real HTTP, real signatures) | OAuth, adopt existing listings, publish/confirm/fail, category attributes, orders (incl. Amazon RDT), tracking, fees/refunds/payouts, stock & price push; AliExpress/CJ connect, sync, order, tracking | `apps/api/test/connectors.test.ts` — 19 tests. Then: live sandbox smoke test per marketplace once credentials exist |
| Operations | Vitest | AI assistant (request shape, facts-only, limits, refusal, permissions, demo), automation rules, all reports + export | `apps/api/test/ops.test.ts` |
| Load (Phase 4) | k6 | 20k products / 100k listings / 100k orders per month: list & search p95 < 300 ms, import 5k rows < 2 min | staging |
| Security | `pnpm audit`, OWASP ZAP baseline on staging, dependency updates | | CI / staging |

Run locally: `pnpm test:core`, `pnpm test:api` (needs PostgreSQL; set `TEST_DATABASE_URL`),
`pnpm --filter @fr/e2e test:e2e` (needs the stack running with `DEMO_MODE=true` and the seed).
CI (`.github/workflows/ci.yml`) runs typecheck, unit, integration, web build and e2e on every PR.

## 8.3 Acceptance criteria (spec §23) — status in this release

| Criterion | Status | Evidence |
|---|---|---|
| Import & manage 5,000 UK + 300+ US products | ✅ | `imports.test.ts`: 5,300 rows (1,250 UK products × 4 variants + 300 US) validated, previewed and imported in ~75 s; grouping, costs, suppliers, stock and prices verified |
| One master product → multiple marketplace listings | ✅ | listings unique per (account, marketplace SKU); product page lists all |
| Per-marketplace currency, attributes, pricing, identifiers | ✅ | listing currency fixed per marketplace; content per version; SKU aliases |
| Costs and cost history preserved | ✅ | effective-dated records, partial unique index, backdating refused, supplier price history |
| Estimated profit with configurable fees & costs | ✅ | core profit engine + fee rules + API |
| Actual financial data reconciled where supported | ✅ (mock) | eBay Finances, Amazon financial events & settlements, TikTok statements imported and reconciled in `connectors.test.ts`; verify with real accounts |
| Drafts saved, edited, validated, approved | ✅ | workflow tests + e2e |
| Publishing via authorised marketplace integration | ✅ (mock) | Real connector code publishes to the mock eBay/Amazon/TikTok APIs; Active only after marketplace confirmation; unconnected accounts refused. Needs real credentials for **verified** |
| Publication failures visible and recoverable | ✅ | failure path, readable error, retry, revise (tested with demo connector) |
| Inventory updates don't overwrite marketplace settings | ✅ by design | listing content is versioned; sync only plans quantity/pause actions; master edits never rewrite listings |
| Staff permissions enforced by backend | ✅ | global guard + state machine; tests |
| Financial/listing changes auditable | ✅ | append-only audit log (DB trigger), status history, version authorship |
| Bulk imports/exports/listing ops with progress & error reports | ✅ | import progress, error downloads, bulk draft/approve/publish results |
| Credentials securely stored | ✅ | AES-256-GCM, never returned by the API; signed OAuth state; exercised by the connector tests |
| Automated jobs can be paused safely | ✅ | emergency controls; publish refused and queued jobs wait (tested) |
| Automated tests for financial, inventory and publishing logic | ✅ | 152 automated tests (65 unit, 81 integration, 6 e2e) |
| Unit, integration, e2e tests; API docs; migrations; deployment instructions | ✅ | see `docs/openapi.json`, `apps/api/prisma/migrations`, `docs/09-deployment.md` |
| Demo mode separate from production | ✅ | `DEMO_MODE` refused in production; DEMO accounts/ids labelled |

## 8.4 Decisions recorded (October 2026)

| Topic | Decision | Effect |
|---|---|---|
| VAT on overseas dropshipping | Apply the UK low-value import rule automatically per supplier | **Built now** (was Phase 5): ships-from country on suppliers and supplier SKUs (and the import file), rule resolved per order line, reason recorded; can be switched off in Settings |
| Existing eBay listings | Keep managing them the existing way | eBay connector uses the **Trading API** for listing operations; existing Seller Hub listings are adopted, not migrated |
| AliExpress | Use the official AliExpress dropshipping API | **Built** (OAuth, product/stock/price sync, order create, tracking) against the mock; needs the **approved app key and secret** |
| Amazon orders | Fashion Rockstar ships them itself | Apply for the restricted Direct-to-Consumer Shipping role; customer data encrypted, access audited, deleted ≤ 30 days after delivery (**built now**) |

## 8.5 Still to confirm

1. Is the AliExpress developer app **already approved** for the dropshipping APIs? If not, apply via
   the AliExpress Open Platform; manual checks continue meanwhile.
2. For the Amazon restricted-role application: hosting provider and a written security / incident
   response policy.
3. Ships-from country for each existing supplier (the dashboard and supplier list flag missing ones).
4. Default thresholds (minimum profit £3, margin 15%, cost verification 30 days, supplier
   staleness 48h, dropship buffer 50% / 2 units / max 10, non-Amazon customer data 90 days).
