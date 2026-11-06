# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage: install the whole workspace, build every package in dependency
# order, then drop dev-only dependencies.
# ---------------------------------------------------------------------------
FROM node:24-alpine AS build
# pnpm refuses to purge/reinstall node_modules without a TTY unless CI is set;
# this also makes every pnpm prompt non-interactive during the image build.
ENV CI=true
RUN corepack enable && corepack prepare pnpm@11.12.0 --activate

WORKDIR /app

# Copy manifests first so the dependency layer caches independently of sources.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/api-contract/package.json packages/api-contract/
COPY apps/auth-server/package.json apps/auth-server/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/auth-server ./apps/auth-server

RUN pnpm --filter @skymatrix/shared-types build \
 && pnpm --filter @skymatrix/api-contract build \
 && pnpm --filter @skymatrix/auth-server build

# Re-install with production dependencies only. `pnpm prune --prod` is NOT usable
# here: inside a workspace it leaves each package's node_modules without its
# dependency symlinks, so the runtime image fails with ERR_MODULE_NOT_FOUND.
# A fresh `--prod` install rebuilds the correct pnpm symlink graph.
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

# ---------------------------------------------------------------------------
# Runtime stage: no toolchain, no sources, runs as an unprivileged user.
# ---------------------------------------------------------------------------
FROM node:24-alpine AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

WORKDIR /app

RUN addgroup -S skymatrix && adduser -S skymatrix -G skymatrix

COPY --from=build /app/node_modules ./node_modules
# Copy each workspace package whole: its dependency symlinks live in its OWN
# node_modules and a dependency-free package has no node_modules directory at
# all, which makes granular COPY of `node_modules` fail with "not found".
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/auth-server ./apps/auth-server

USER skymatrix

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/auth-server/dist/server.js"]
