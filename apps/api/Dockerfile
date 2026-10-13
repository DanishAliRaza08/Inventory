# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f apps/api/Dockerfile .
FROM node:22-bookworm-slim AS build
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @fr/api... --filter @fr/core
COPY packages/core packages/core
COPY apps/api apps/api
RUN pnpm --filter @fr/core build && pnpm --filter @fr/api prisma:generate && pnpm --filter @fr/api build
RUN pnpm deploy --filter @fr/api --prod --legacy /out && cp -r apps/api/dist apps/api/prisma /out/ \
  && cd /out && npx prisma generate --schema prisma/schema.prisma

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/* && useradd -r -u 1001 app
WORKDIR /app
COPY --from=build --chown=app /out .
USER app
ENV NODE_ENV=production PORT=4000
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Run `npx prisma migrate deploy` as a release step before starting new versions.
CMD ["node", "dist/src/main.js"]
