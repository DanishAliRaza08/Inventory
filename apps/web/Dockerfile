# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f apps/web/Dockerfile .
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @fr/web
COPY apps/web apps/web
ENV NEXT_TELEMETRY_DISABLED=1
ARG API_URL=http://api:4000
ENV API_URL=$API_URL
RUN pnpm --filter @fr/web build

FROM node:22-bookworm-slim AS runtime
RUN corepack enable && useradd -r -u 1001 app
WORKDIR /repo
COPY --from=build --chown=app /repo .
USER app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
EXPOSE 3000
CMD ["pnpm", "--filter", "@fr/web", "start"]
