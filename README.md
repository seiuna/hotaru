# Skymatrix — MC Auth Platform

Premium Minecraft authentication and authorization for the Skymatrix servers, built as an independent
identity provider.

A Fabric client proves it owns a premium Minecraft account through the vanilla `join` / `hasJoined`
handshake, and receives an **Ed25519 JWT** that the rest of the platform can verify. The service never
sees, stores or forwards a Mojang access token: it holds only public proofs, hashed refresh tokens and
its own signing keys.

```
   Fabric client (mod + fabric-sdk-java)
            │
            │  1. POST /auth/minecraft/challenge   →  { serverId, publicKey, verifyToken }
            │  2. vanilla join with Mojang        →  (client ↔ Mojang, never through us)
            │  3. POST /auth/minecraft/verify     →  { accessToken, refreshToken, scopes }
            ▼
   ┌──────────────────────────────┐     ┌──────────────┐
   │  auth-server (Fastify, :3000)│────►│  MongoDB 7   │  users, permissions, sessions,
   │                              │     │              │  refresh tokens, audit, keys
   │  routes → services →         │     └──────────────┘
   │  infrastructure              │     ┌──────────────┐
   │                              │────►│  Redis 7     │  challenges, rate limits,
   │                              │     │              │  revocation fast path
   └───────────────┬──────────────┘     └──────────────┘
                   │ HTTPS
          ┌────────▼─────────┐            ┌───────────────────────────┐
          │  Caddy (TLS,     │            │  Mojang session server    │
          │  HSTS, 64 KB cap)│            │  /session/minecraft/      │
          └──────────────────┘            │  hasJoined                │
                                          └───────────────────────────┘
```

## Documentation

| Document | What it covers |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Module map, request lifecycle, boot sequence, why a modular monolith |
| [docs/authentication.md](docs/authentication.md) | The full handshake, challenge state machine, every failure mode |
| [docs/api.md](docs/api.md) | Every endpoint with request/response examples and the error table |
| [docs/database.md](docs/database.md) | Collections, indexes, TTL rationale, index creation in production |
| [docs/security.md](docs/security.md) | Threat model with mitigations and residual risk |
| [docs/deployment.md](docs/deployment.md) | Compose/Dockerfile/Caddyfile, sizing, TLS, backups, key rotation, monitoring |
| [docs/openapi.json](docs/openapi.json) / [docs/openapi.yaml](docs/openapi.yaml) | Generated OpenAPI 3.1 contract |
| [docs/dev-contract.md](docs/dev-contract.md) | Internal development contract (scope, interfaces, conventions) |

## Quickstart (production-style stack)

Requirements: Docker Engine or Docker Desktop with Compose v2, a DNS record for your auth domain, ports
80/443 reachable.

```bash
# 1. Configuration
cp deploy/.env.example deploy/.env      # PowerShell: Copy-Item deploy\.env.example deploy\.env
#    edit deploy/.env: AUTH_DOMAIN, ACME_EMAIL, PUBLIC_BASE_URL,
#    MONGO_INITDB_ROOT_PASSWORD, REDIS_PASSWORD
#    passwords must be URL-safe (no @ : / # ? %) — they are interpolated into connection URLs

# 2. Build and start (Caddy + auth-server + MongoDB + Redis)
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --build

# 3. Verify
curl -fsS https://auth.example.com/api/v1/health/live     # {"status":"ok",...}
curl -fsS https://auth.example.com/api/v1/health/ready    # both dependencies "ok"
```

Before real traffic: seed an administrator, and confirm the MongoDB indexes were created at boot
(`MONGODB_ENSURE_INDEXES=true` by default creates the unique constraints the platform depends on — see
[deployment.md](docs/deployment.md#index-creation-and-model-changes-in-production)).

## Seeding the first administrator

`admin:users` is granted, never self-assigned. With MongoDB reachable on `127.0.0.1:27017`:

```bash
pnpm --filter @skymatrix/auth-server admin:seed -- --uuid <minecraft-uuid> --username <name>
```

The script creates the user row if needed, upserts the `admin:users` grant, and is idempotent. In a
production deployment the database is intentionally not published to the host — see
[deployment.md](docs/deployment.md#seeding-the-first-administrator) for the two supported production
routes.

## API at a glance

Base path `/api/v1`. Full details and examples: [docs/api.md](docs/api.md).

| Method | Path | Auth | Success |
| --- | --- | --- | --- |
| POST | `/auth/minecraft/challenge` | public | `200` challenge (serverId, publicKey, verifyToken, expiresIn) |
| POST | `/auth/minecraft/verify` | public | `200` token pair |
| POST | `/auth/refresh` | refresh token | `200` rotated token pair |
| POST | `/auth/logout` | Bearer | `204` |
| GET | `/auth/jwks` | public | `200` JWKS (Ed25519) |
| GET | `/users/me` | Bearer | `200` profile + effective scopes |
| GET | `/users/me/permissions` | Bearer | `200` grants (incl. expired) + effective scopes |
| GET | `/admin/users` | `admin:users` | `200` paginated user search |
| PUT | `/admin/users/{id}/permissions` | `admin:users` | `200` replaced grants |
| POST | `/admin/users/{id}/ban` | `admin:users` | `200` user + revoked session count |
| POST | `/admin/users/{id}/unban` | `admin:users` | `200` user |
| POST | `/admin/sessions/{id}/revoke` | `admin:users` | `200` session |
| GET | `/admin/audit-logs` | `admin:users` | `200` paginated audit trail |
| GET | `/health/live` | public | `200` liveness (no dependencies) |
| GET | `/health/ready` | public | `200` / `503` MongoDB + Redis |

Errors are uniform: `{ "error": { "code", "message", "retryable", "details"? } }` with 15 stable codes
(`INVALID_REQUEST`, `CHALLENGE_EXPIRED`, `REFRESH_REUSED`, `MOJANG_UNAVAILABLE`, …).

## Security guarantees

- **Identity comes only from Mojang.** The verify request has no UUID field; the player's UUID is taken
  from `hasJoined`. A client-supplied identity is never trusted.
- **No Mojang credential ever reaches us.** The shared secret is hashed into the server-id and dropped;
  the Mojang access token stays on the client.
- **One-shot challenges and rotating refresh tokens.** Both are consumed atomically in Redis/MongoDB;
  a replayed refresh token revokes the whole session (`REFRESH_REUSED`).
- **Authority is re-derived per request.** Access tokens are short-lived (default 15 min) and every
  request reloads the session, the user status and the permission set from MongoDB — so a ban or a
  revoked permission applies on the next call, not at token expiry.
- **Fail closed.** Mojang down, Redis down, Mongo down or an ambiguous token state means "no token",
  never "allow".
- **Failures leak nothing.** One error envelope, no stack traces, no decryption oracle, malformed ids
  return the same `404` as unknown ids.
- **Secrets stay out of logs.** `Authorization`/`Cookie` are redacted by Fastify and by Caddy; tokens,
  shared secrets and private keys are never logged, never stored in plaintext (refresh tokens only as
  SHA-256).

Details and residual risks: [docs/security.md](docs/security.md).

## Local development

Requirements: Node.js ≥ 20.11 (tested on 24), pnpm 11 via corepack.

```bash
corepack enable && corepack prepare pnpm@11.12.0 --activate
pnpm install
```

Start the two backing services. **Redis is exposed on host port 16379, not 6379**, because Docker
Desktop on this host cannot bind 6379:

```bash
docker run -d --name skymatrix-mongo -p 127.0.0.1:27017:27017 mongo:7
docker run -d --name skymatrix-redis -p 127.0.0.1:16379:6379 redis:7-alpine
```

`apps/auth-server/.env` (git-ignored) already points at both:

```
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DB=skymatrix_auth
REDIS_URL=redis://127.0.0.1:16379
PUBLIC_BASE_URL=http://localhost:3000
```

Then:

```bash
pnpm dev                                   # tsx watch src/server.ts on http://localhost:3000
# Swagger UI: http://localhost:3000/docs    (blocked at the edge in production)

pnpm typecheck                             # tsc --noEmit across the workspace
pnpm --filter @skymatrix/auth-server test  # unit tests (vitest)
pnpm --filter @skymatrix/auth-server test:integration   # needs the containers above

pnpm --filter @skymatrix/auth-server openapi:export     # regenerate docs/openapi.{json,yaml}
pnpm --filter @skymatrix/auth-server admin:seed -- --uuid <uuid> --username <name>

node tools/e2e/smoke.mjs                   # full user story against a fake Mojang server
```

Integration tests use `MONGODB_DB=skymatrix_auth_test`, `MONGODB_URI=mongodb://127.0.0.1:27017`,
`REDIS_URL=redis://127.0.0.1:16379` and clean up their own data. The e2e smoke test boots its own
auth-server on port 3100 plus a fake Mojang server on 8787.

`pnpm infra:up` starts only the compose `mongo` and `redis` containers. Those intentionally publish
**no** host ports (production posture), so they are not usable from a host-side `pnpm dev`; use the
`docker run` commands above.

## Project layout

```
skymatrix-servers/
├── apps/
│   ├── auth-server/                  # @skymatrix/auth-server — the platform
│   │   ├── src/
│   │   │   ├── server.ts             # boot: config → mongo → redis → keys → app → listen
│   │   │   ├── app.ts                # Fastify wiring, plugins, route registration, /jwks
│   │   │   ├── context.ts            # AppContext { config, keys, redis }
│   │   │   ├── config/env.ts         # Zod-validated environment
│   │   │   ├── errors.ts             # AppError + Errors.* (one code per failure)
│   │   │   ├── http/zod-schema.ts    # Zod → OpenAPI JSON Schema, client ip/UA helpers
│   │   │   ├── plugins/              # auth guard, global error handler
│   │   │   ├── infrastructure/       # mongo models, redis client, crypto, Mojang client
│   │   │   └── modules/              # health, minecraft-auth, tokens, users, admin, audit
│   │   ├── scripts/                  # export-openapi.ts, seed-admin.ts
│   │   └── tests/integration/        # real Mongo + Redis integration tests
│   └── api/                          # @skymatrix/api — leftover monorepo scaffold, not deployed
├── clients/fabric-sdk-java/          # dependency-free Java client for the handshake
├── packages/
│   ├── shared-types/                 # SCOPES, ERROR_CODES, token claims, view types
│   └── api-contract/                 # Zod schemas for every request/response
├── deploy/                           # Dockerfile, compose.yaml, Caddyfile, .env.example
├── docs/                             # architecture, auth, api, database, security, deploy, openapi
└── tools/e2e/                        # fake Mojang server + end-to-end smoke test
```

## Common commands

| Command | Description |
| --- | --- |
| `pnpm install` | Install workspace dependencies (frozen lockfile in CI/Docker) |
| `pnpm dev` | auth-server with hot reload |
| `pnpm build` | Build every workspace package in dependency order |
| `pnpm typecheck` | `tsc --noEmit` everywhere |
| `pnpm test` | Unit tests of every package |
| `pnpm lint` | ESLint over `src` and `tests` |
| `pnpm format` | Prettier |
| `pnpm --filter @skymatrix/auth-server openapi:export` | Regenerate `docs/openapi.{json,yaml}` from the live app |
| `pnpm infra:up` / `infra:down` | compose `mongo` + `redis` only (no host ports) |

## Status and roadmap

Working today:

- Minecraft premium handshake (challenge/verify) with RSA-1024 + vanilla signed server hash, Mojang
  `hasJoined` with bounded retries, rate limiting, one-shot challenges with terminal-state markers.
- Sessions, Ed25519 access tokens, JWKS, rotating refresh tokens with reuse detection, logout.
- Users (`/users/me`, permissions), admin API (user search, permission replacement, ban/unban, session
  revocation, audit log), first-admin seeding.
- Health probes, global error envelope, audit trail, OpenAPI export, Docker/Compose/Caddy deployment,
  Java client SDK, unit + integration tests, e2e smoke test.

Not built yet (deliberate scope gaps):

- `licenses` collection has no API surface yet (the `skymatrix:license` scope is reserved).
- No admin web UI; administration is the JSON API.
- No metric endpoint (Prometheus/OpenTelemetry); monitoring is health probes + structured logs.
- Key rotation has no dual-key overlap window — rotation is an atomic re-login event.
- No second factor for administrators beyond their Minecraft account security.
- The `skymatrix:resource` / `skymatrix:ircserver` scopes are issued but their downstream services are
  outside this repository.

## Repository extras

- **`tools/e2e/smoke.mjs`** — the end-to-end harness behind the "47/47 checks" claim. It starts a fake
  Mojang session server, boots the real auth server against a throwaway database, then plays the whole
  user story with a client written independently of the server code (challenge → RSA handshake → Mojang
  join → verify → JWT → refresh → reuse detection → admin grant → ban → outage → rate limit → audit).
  Run `node tools/e2e/smoke.mjs`. `tools/e2e/fake-mojang.mjs` is its stand-in for Mojang.
- **`apps/api` + `packages/shared`** — the original pnpm-workspace scaffold (a tiny HTTP service). It is
  kept as a smoke target for `.agents/skills/verify-api/`; nothing in the auth platform imports it.
- **`docs/dev-contract.md`** — the internal contract used while building the platform in parallel (owned
  interfaces, conventions, Redis keys, wire formats, local ports). Useful when several people or agents
  work on this repo at once.

