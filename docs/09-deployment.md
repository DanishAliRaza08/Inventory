# 9. Deployment & operations

## Environments

| | Development | Staging | Production |
|---|---|---|---|
| Database | local PostgreSQL 16 | managed PostgreSQL (separate instance) | managed PostgreSQL with PITR backups |
| Queue | `QUEUE_MODE=inline` or local Redis | managed Redis | managed Redis (persistence on) |
| Storage | local disk (`UPLOAD_DIR`) | S3-compatible bucket | S3-compatible bucket, versioning on |
| Marketplace apps | none / DEMO | **sandbox** apps & accounts | production apps |
| `DEMO_MODE` | allowed | allowed only on a separate demo stack | **refused at boot** |
| `MOCK_MARKETPLACES` | allowed (mock server on `:4100`) | not used — sandbox apps instead | **refused at boot** |
| MFA for privileged roles | optional | enforced | enforced (`MFA_ENFORCE_FOR_PRIVILEGED=true`) |

## Local setup

```bash
# prerequisites: Node 22, pnpm 10, PostgreSQL 16, Redis 7 (or `docker compose up postgres redis`)
pnpm install
cp apps/api/.env.example apps/api/.env      # fill APP_ENCRYPTION_KEY, DATABASE_URL, SEED_OWNER_*
pnpm --filter @fr/core build
pnpm --filter @fr/api prisma:generate
pnpm db:migrate                               # prisma migrate deploy
pnpm db:seed                                  # roles, permissions, marketplace accounts, owner (+ demo data if DEMO_MODE=true)
pnpm dev:api                                  # http://localhost:4000/api  (Swagger: /api/docs)
pnpm --filter @fr/api worker                  # when QUEUE_MODE=bullmq (after `pnpm --filter @fr/api build`)
pnpm dev:web                                  # http://localhost:3000
```

Full stack in containers: `APP_ENCRYPTION_KEY=$(openssl rand -base64 32) docker compose up --build`.

### Dummy data and mock marketplaces

* `DEMO_MODE=true` + `pnpm --filter @fr/api demo` fills an empty database with a DEMO business:
  ~25 products / 150 SKUs, listings on the four DEMO accounts and ~90 days of orders pushed
  through the real ingestion, dispatch and reconciliation code (fees, payouts, refunds, returns,
  expenses, automation rules). `DEMO_DAYS` and `DEMO_ORDERS_PER_DAY` adjust the volume.
* `MOCK_MARKETPLACES=true` + `pnpm --filter @fr/api mock` runs the mock eBay / Amazon / TikTok /
  AliExpress / CJ APIs. Every real connector then talks to it, so **Connect**, publishing, order
  sync, tracking and finance sync can be tried on the non-demo accounts with dummy data.

## Sizing

* API: set `API_WORKERS` to the number of CPU cores (Node cluster; a crashed process is replaced
  automatically). 2 vCPU / 2 GB is enough for a 10-person team; the load test (docs/08 §8.6) used 4.
* PostgreSQL: 2 vCPU / 4 GB for the documented volume (20k products, 100k listings, 100k orders a
  month); enable `pg_trgm` (the migrations do) and keep autovacuum on.
* Dashboard and report aggregates are cached per API process for `AGGREGATE_CACHE_SECONDS` (60 s).
* Before go-live, run `load:data` + `load:test` against a staging copy of the production hardware.

## Background worker

`pnpm --filter @fr/api worker` (production: same image, command `node dist/src/worker.js`) runs the
queue consumers and this schedule (each task never overlaps itself; failures are logged and
retried on the next tick):

| Task | Every | Setting |
|---|---|---|
| Publication sweep (queued publish / confirm / price-quantity jobs) | 1 min | — |
| Order sync, all connected accounts | 10 min | `SYNC_ORDERS_EVERY_MIN` |
| Fees, refunds and payouts sync | 60 min | `SYNC_FINANCE_EVERY_MIN` |
| Stock push to marketplaces | 15 min (plus immediately on stock changes) | `SYNC_INVENTORY_EVERY_MIN` |
| Supplier price and stock sync (AliExpress, CJ) | 6 h | `SYNC_SUPPLIERS_EVERY_MIN` |
| Supplier tracking poll | 30 min | — |
| Automation rules due to run | 5 min | per rule |
| AI image checks for new images (only with `ANTHROPIC_API_KEY`) | 30 min | — |
| Customer data retention purge | 60 min | Settings → privacy |

Emergency controls (Settings) stop publishing, repricing, inventory sync or automation without
stopping the worker. Setting an interval to `0` disables that task.

## Release procedure

1. CI green on the commit (typecheck, unit, integration, web build, e2e).
2. Build images (`apps/api/Dockerfile`, `apps/web/Dockerfile`) tagged with the commit SHA.
3. Take a database snapshot.
4. Run migrations as a one-off job: `npx prisma migrate deploy --schema prisma/schema.prisma`.
   Migrations are forward-only and written to be backward compatible with the previous release
   (expand → migrate → contract across two releases for destructive changes).
5. Deploy API + worker, then web. Health check: `GET /api/health` (database + Redis).
6. Smoke test; if a marketplace-facing problem appears, use **Settings → Emergency controls** to
   stop publishing / repricing / inventory sync immediately (no data is lost), then roll back the
   image if needed.

## Secrets

`APP_ENCRYPTION_KEY` (32 bytes, base64), database and Redis URLs, marketplace client ids/secrets,
S3 credentials and error-tracking DSNs come from the platform's secret manager — never from the
repository. Marketplace user tokens are stored encrypted in `integration_credentials`.
The full list of variables, where each comes from and the callback URLs to register is in the
[README → What you need to provide](../README.md#what-you-need-to-provide). `PUBLIC_BASE_URL` must be a public
HTTPS address: OAuth callbacks land there and marketplaces download listing images from its signed
`/api/public/images/...` links.
Key rotation: add the new key as version 2, re-encrypt credentials in a background job, retire v1.

## Backups & recovery

* PostgreSQL: daily snapshots kept 35 days + point-in-time recovery (7 days).
* Object storage: versioning + lifecycle rules.
* **Restore drill quarterly**: restore the latest snapshot to staging, run migrations and the e2e
  suite against it; record the time to recover.

## Monitoring

* `/api/health`; uptime checks on API and web.
* Structured logs (JSON) shipped to the log platform; error tracking (e.g. Sentry) on API, worker
  and web.
* Alerts: failed publication jobs, queue depth/age, sync staleness (`sync_states.last_success_at`),
  marketplace operation failure rate, 5xx rate, database CPU/storage.

## Data protection (UK GDPR)

* Customer PII only in `order_customers`, visible only with `orders.customer_pii`; purged after
  `privacy.customer_data_retention_days`.
* Access is role-based and audited; staff accounts are individual; MFA for privileged roles.
* Subject access / erasure requests: find by order or email, export, then purge PII while keeping
  the anonymised financial record required for accounting.

## Security incident response

1. **Contain:** use the emergency controls, revoke affected sessions (`Users → Disable`), rotate
   exposed credentials (marketplace tokens, `APP_ENCRYPTION_KEY` via key versioning).
2. **Assess:** use the audit log (`customer_pii.read`, `auth.*`, `integration.*`) to establish what
   data and which customers were affected.
3. **Notify:** incidents involving Amazon customer data must be reported to Amazon (security@amazon.com)
   **within 24 hours** of detection; personal-data breaches likely to risk individuals must be
   reported to the ICO within 72 hours; affected marketplaces per their policies.
4. **Recover & review:** restore from backups if needed, then write a post-incident review.
