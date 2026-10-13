# 1. System architecture & technology decisions

## Summary

A **modular monolith** (one deployable API + one worker process + one web app) backed by
PostgreSQL and Redis. Marketplace connectors are isolated behind a single interface so each
can be built, tested and changed independently. Microservices are deliberately deferred until
measured load justifies them (see *Scaling path*).

```mermaid
flowchart LR
  subgraph Browser
    WEB[Next.js web app<br/>React + TypeScript + Tailwind]
  end
  subgraph Platform
    API[NestJS API<br/>REST + OpenAPI]
    WORKER[Worker process<br/>BullMQ consumers + sweeps]
    CORE[[@fr/core<br/>pure domain logic]]
    PG[(PostgreSQL 16)]
    REDIS[(Redis<br/>queues)]
    OBJ[(S3-compatible<br/>object storage)]
  end
  subgraph Marketplaces["Official marketplace APIs"]
    EB[eBay UK / eBay US<br/>Sell Inventory, Fulfillment, Finances, Taxonomy]
    AZ[Amazon UK<br/>Selling Partner API]
    TT[TikTok Shop UK<br/>Open API]
  end
  subgraph Suppliers
    CJ[CJ Dropshipping API]
    AE[AliExpress (manual / official API where approved)]
  end
  WEB -- session cookie + CSRF header --> API
  API --> CORE
  WORKER --> CORE
  API --> PG
  WORKER --> PG
  API -- enqueue --> REDIS
  REDIS --> WORKER
  API --> OBJ
  WORKER -- OAuth tokens (decrypted in memory only) --> EB & AZ & TT
  WORKER --> CJ & AE
```

## Technology decisions

| Concern | Decision | Why |
|---|---|---|
| Language | TypeScript end-to-end | One language for web, API and domain logic; shared types. |
| Domain logic | `packages/core` (framework-free, pure functions) | Profit, fees, FX, pricing, lifecycle and inventory rules are the business's crown jewels; they are unit-tested in isolation (58 tests) and reused by API and worker. |
| Money | `decimal.js`, `DECIMAL(14,4)` columns, ISO-4217 code on every amount | No floating-point errors; never mixes currencies implicitly. |
| API | NestJS 11 (Express 5) | Modular structure, guards for RBAC, OpenAPI generation. |
| Validation | Zod schemas at every API boundary | Same schema validates and documents (OpenAPI via zod-to-json-schema). |
| Database | PostgreSQL 16 + Prisma 6 with **versioned SQL migrations** | Relational integrity, CHECK constraints, partial unique indexes, JSONB for marketplace-specific content, trigram search. |
| Queue | Redis + BullMQ; `QUEUE_MODE=inline` for tests | Reliable background jobs with delayed retries; same handlers run inline in tests. |
| Storage | `StorageService` (local disk driver now; S3-compatible driver for staging/prod) | Images, receipts, import files. |
| Auth | Server-side sessions (hashed random token in httpOnly cookie), argon2id passwords, TOTP MFA | Revocable sessions, no JWTs in the browser, MFA for privileged roles. |
| Web | Next.js (App Router) + Tailwind CSS | Responsive admin UI; accessible components. |
| Docs | OpenAPI at `/api/docs` (non-production) and `pnpm --filter @fr/api openapi` export | |
| Observability | Structured logs, `/api/health` (DB + Redis), marketplace operation log table; Sentry/OTel to be wired in staging | |

## Module boundaries (API)

| Module | Responsibility |
|---|---|
| `auth`, `users` | Sessions, MFA, roles, custom roles, permission guard |
| `audit` | Append-only audit trail (DB trigger forbids UPDATE/DELETE) |
| `settings` | Typed settings: thresholds, tax defaults, **emergency controls** |
| `products` | Master catalogue, variants/SKUs, SKU aliases, images, global search, duplicates |
| `suppliers`, `costs` | Suppliers, supplier products, price history, **effective-dated costs** |
| `inventory` | Stock buckets, idempotent movements, availability (physical vs dropship) |
| `finance` | FX rates, fee rules, profit calculators, reverse pricing, expenses |
| `listings` | Listing builder, versions, validation, approval workflow, publication jobs |
| `integrations` | Connector interface, registry, capability matrix, marketplace accounts |
| `imports` | Import wizard, error reports, exports |
| `dashboard` | KPIs, time series, data-freshness warnings |

## Environments

| Environment | Purpose | Notes |
|---|---|---|
| development | Local work | `DEMO_MODE` allowed; inline or BullMQ queue |
| staging | Pre-release testing against marketplace **sandbox** accounts | Same infra as production, separate DB/Redis/bucket and separate marketplace apps |
| production | Live operations | `DEMO_MODE` refused at boot; MFA enforced for privileged roles; Swagger UI disabled |

## Reliability principles

* **Idempotency everywhere external:** publication jobs keyed `listing:version:operation`;
  inventory movements keyed by caller-supplied idempotency keys (unique index); orders unique on
  `(account, external_order_id)`; fees unique on `(source, external_ref)`.
* **Transactions + row locks** (`SELECT … FOR UPDATE`, advisory locks) for stock, costs and
  listing state; CHECK constraints make negative stock impossible even under bugs.
* **Never claim success without confirmation:** a listing becomes `ACTIVE` only on the marketplace's
  confirmation (also enforced by a DB constraint requiring an external listing id).
* **Bounded retries** with exponential backoff + jitter for transient errors only; permanent errors
  fail fast with a readable explanation and next action.
* **Emergency controls** (publishing, repricing, inventory sync, automation) stop outbound
  automation without deleting data; queued jobs wait and resume when re-enabled.

## Scaling path (20k products, 100k listings, 100k orders/month)

* Indexed, paginated queries everywhere; trigram GIN indexes for title/SKU search.
* Dashboard aggregates computed in SQL over `profit_calculations`; next step is a nightly
  materialised daily-summary table once order volume is live.
* Worker concurrency and per-marketplace rate limiters scale horizontally (stateless workers).
* Partition `audit_logs`, `marketplace_operations` and `inventory_movements` by month when they
  exceed ~50M rows.
* Split a connector into its own service only if its rate-limit or deployment cadence demands it;
  the interface boundary already exists.
