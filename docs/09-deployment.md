# 9. Deployment & operations

## Environments

| | Development | Staging | Production |
|---|---|---|---|
| Database | local PostgreSQL 16 | managed PostgreSQL (separate instance) | managed PostgreSQL with PITR backups |
| Queue | `QUEUE_MODE=inline` or local Redis | managed Redis | managed Redis (persistence on) |
| Storage | local disk (`UPLOAD_DIR`) | S3-compatible bucket | S3-compatible bucket, versioning on |
| Marketplace apps | none / DEMO | **sandbox** apps & accounts | production apps |
| `DEMO_MODE` | allowed | allowed only on a separate demo stack | **refused at boot** |
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
