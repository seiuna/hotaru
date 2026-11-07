# Hotaru — MC Auth Platform

Premium Minecraft authentication and authorization for the Hotaru servers, built as an independent
identity provider.

A Fabric client proves it owns a premium Minecraft account through the vanilla `join` / `hasJoined`
handshake, and receives an **Ed25519 JWT** that the rest of the platform can verify. The service never
sees, stores or forwards a Mojang access token: it holds only public proofs, hashed refresh tokens and
its own signing keys.

```
   Fabric client (mod + hotaru-sdk-java)
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
pnpm --filter @hotaru/auth-server admin:seed -- --uuid <minecraft-uuid> --username <name>
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
docker run -d --name hotaru-mongo -p 127.0.0.1:27017:27017 mongo:7
docker run -d --name hotaru-redis -p 127.0.0.1:16379:6379 redis:7-alpine
```

`apps/auth-server/.env` (git-ignored) already points at both:

```
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DB=hotaru_auth
REDIS_URL=redis://127.0.0.1:16379
PUBLIC_BASE_URL=http://localhost:3000
```

Then:

```bash
pnpm dev                                   # tsx watch src/server.ts on http://localhost:3000
# Swagger UI: http://localhost:3000/docs    (blocked at the edge in production)

pnpm typecheck                             # tsc --noEmit across the workspace
pnpm --filter @hotaru/auth-server test  # unit tests (vitest)
pnpm --filter @hotaru/auth-server test:integration   # needs the containers above

pnpm --filter @hotaru/auth-server openapi:export     # regenerate docs/openapi.{json,yaml}
pnpm --filter @hotaru/auth-server admin:seed -- --uuid <uuid> --username <name>

node tools/e2e/smoke.mjs                   # full user story against a fake Mojang server
```

Integration tests use `MONGODB_DB=hotaru_auth_test`, `MONGODB_URI=mongodb://127.0.0.1:27017`,
`REDIS_URL=redis://127.0.0.1:16379` and clean up their own data. The e2e smoke test boots its own
auth-server on port 3100 plus a fake Mojang server on 8787.

`pnpm infra:up` starts only the compose `mongo` and `redis` containers. Those intentionally publish
**no** host ports (production posture), so they are not usable from a host-side `pnpm dev`; use the
`docker run` commands above.

## Project layout

```
hotaru-servers/
├── apps/
│   ├── auth-server/                  # @hotaru/auth-server — the platform
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
│   │   ├── scripts/                  # export-openapi, seed-admin, activation-code, migrate, seed-player
│   │   └── tests/integration/        # real Mongo + Redis integration tests
│   ├── admin-web/                    # @hotaru/admin-web — operator console
│   └── api/                          # @hotaru/api — leftover monorepo scaffold, not deployed
├── clients/hotaru-sdk-java/          # Java 21 SDK: auth handshake + login bridge + IRC/REST clients
├── examples/fabric-mod/              # Fabric wiring examples (not compiled by the library)
├── packages/
│   ├── shared-types/                 # SCOPES, ERROR_CODES, token claims, view types
│   └── api-contract/                 # Zod schemas for every request/response
├── deploy/                           # Dockerfile, compose.yaml, Caddyfile, .env.example
├── docs/                             # architecture, auth, api, database, security, deploy, openapi
└── tools/e2e/                        # fake Mojang server + end-to-end smoke test
```

## Interactive setup

Hotaru includes an interactive CLI to configure local development or production deployment.
It updates existing git-ignored `.env` files and preserves values, comments and unrelated keys.

```bash
pnpm run setup
```

`pnpm run setup` asks whether to configure `apps/auth-server/.env` plus `apps/irc-server/.env` for
local development, or `deploy/.env` for production. The production path seeds from
`deploy/.env.example`, generates URL-safe MongoDB and Redis passwords, and never prints them.

`@hotaru/admin-web` needs no runtime environment file; its `VITE_API_BASE_URL` is normally empty and
resolved at build time. `@hotaru/api` only reads `PORT` and is not part of the deployed stack.

| Command | Description |
| --- | --- |
| `pnpm run setup` | Interactive setup for local or production env files |
| `pnpm test:setup` | Run tests for the setup tool |

`pnpm setup` is pnpm's own built-in command, so the script must be run with `pnpm run setup`.
Use `pnpm run setup --help` for `--profile`, `--yes`, `--dry-run` and `--rotate-secrets`.

## Common commands

| Command | Description |
| --- | --- |
| `pnpm install` | Install workspace dependencies (frozen lockfile in CI/Docker) |
| `pnpm run setup` | Interactive setup for local or production env files |
| `pnpm test:setup` | Run tests for the setup tool |
| `pnpm dev` | auth-server with hot reload |
| `pnpm build` | Build every workspace package in dependency order |
| `pnpm typecheck` | `tsc --noEmit` everywhere |
| `pnpm test` | Unit tests of every package |
| `pnpm lint` | ESLint over `src` and `tests` |
| `pnpm format` | Prettier |
| `pnpm --filter @hotaru/auth-server openapi:export` | Regenerate `docs/openapi.{json,yaml}` from the live app |
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
- Headless account API with signed activation codes, account/password login, multiple linked Minecraft
  UUIDs, account-scoped MC permissions, account-level and per-UUID bans, legacy-account claim, email
  password reset, rotating refresh tokens and TOTP two-factor authentication.
- Admin console activation-code issuance and per-UUID ban/unban on the user detail page.

Not built yet (deliberate scope gaps):

- `licenses` collection has no API surface yet (the `hotaru:license` scope is reserved).
- No admin web UI; administration is the JSON API.
- No metric endpoint (Prometheus/OpenTelemetry); monitoring is health probes + structured logs.
- Key rotation has no dual-key overlap window — rotation is an atomic re-login event.
- No second factor for administrators beyond their Minecraft account security.
- The `hotaru:resource` / `hotaru:ircserver` scopes are issued but their downstream services are
  outside this repository.

## IRC server (SRP v1)

`apps/irc-server` is the real-time relay for the Hotaru mod: WSS at `GET /v1/connect`, authenticated
with the **same** Ed25519 JWT as the REST API (scope `hotaru:ircserver`, session revocation checked
against the shared Redis key), speaking the **Hotaru Relay Protocol v1** (`packages/srp-protocol`).

```
Fabric mod ──WSS /v1/connect (Bearer JWT)──► irc-server ──► Redis (presence, dedupe, cross-node)
                                                  └──────► MongoDB (groups, filters, audit)
```

- **Routes**: DIRECT (player → player), GROUP (membership-checked), BROADCAST (needs
  `hotaru:irc:broadcast` or an admin UUID).
- **Filters**: deny-first at three levels — global → group → per-recipient user — with only the patterns
  `chat.message`, `chat.*` and `*`.
- **Reliability**: two-phase ACK (`accepted` then `delivered`/`failed`), server-computed TTL, and
  short-window dedupe keyed by *sender + message id* (replays are acknowledged but never re-fanned-out).
- **Limits**: 20 msg/s (+40 burst) per connection, 10 msg/s for groups, 64 KiB payload, 128 KiB frame,
  3 connections per account, 5 group creations per hour, slow sockets closed on backpressure.

```bash
pnpm --filter @hotaru/irc-server dev          # :3001 (needs mongo + redis + auth-server for tokens)
pnpm --filter @hotaru/irc-server test         # 113 unit tests
pnpm --filter @hotaru/irc-server test:integration   # 74 integration tests (real Mongo/Redis/WS)
node tools/e2e/irc/smoke.mjs                     # 39 protocol checks end to end (fake Mojang, self-contained)
node tools/e2e/irc/load.mjs                      # 100-client load check with real percentiles
```

**Java SDK** — `clients/hotaru-sdk-java` (JDK 21 only, no Minecraft dependency), one jar with two
halves: the auth library (`cn.seiua.mcauth`) plus its loopback login bridge, and the SRP v1 relay client
(`cn.seiua.irc` / `cn.seiua.irc.rest`): `IrcClient` hides
the WebSocket, the envelope, ACK correlation, reconnects, de-duplication and token rejection. Wire it with
two things — a `TokenProvider` (the MC Auth JWT) and an `Executor` (the game thread):

```java
IrcClient irc = IrcClient.builder("wss://irc.example.com")
        .tokenProvider(() -> session.accessToken())
        .dispatchExecutor(client::execute)
        .build();
irc.on("chat.message", message -> chat.show(message.text()));
irc.sendDirect(targetUuid, "chat.message", Map.of("text", "hello"));
```

```bash
cd clients/hotaru-sdk-java
javac --release 21 -Xlint:all -d out "@sources.txt"
java -cp out cn.seiua.irc.IrcClientSelfTest   # 44 checks, offline
# real relay: IRC_URL=... IRC_TOKEN=... java -cp out cn.seiua.irc.IrcE2ESelfTest   (14 checks)
```

Protocol and operations: [docs/srp-v1.md](docs/srp-v1.md), [docs/irc-api.md](docs/irc-api.md),
[docs/irc-database.md](docs/irc-database.md), [docs/irc-security.md](docs/irc-security.md),
[docs/irc-deployment.md](docs/irc-deployment.md). Build contract for contributors:
[docs/irc-contract.md](docs/irc-contract.md).

## Admin console (Vue 3 + Naive UI)

`apps/admin-web` is a Vue 3 + Naive UI SPA for operating the platform: bento dashboard, user search,
per-user permission editing with live diff, ban/unban, session revocation and the audit log. It talks
only to the documented admin API.

```bash
pnpm --filter @hotaru/admin-web dev     # http://localhost:5173 (proxies /api to :3000)
pnpm --filter @hotaru/admin-web build   # vue-tsc + vite build -> dist/
pnpm --filter @hotaru/admin-web test    # 20 unit tests
```

**The console uses account/password login.** The account must have `admin:users`; the server checks the
live permission list on every admin API request. The login response also carries a rotating portal refresh
token, so a long session renews silently instead of asking for the password again. Tokens live in
`sessionStorage` only; closing the tab signs you out. There is no token-paste form and no in-game bridge
button.

Local demo account after seeding:

```bash
pnpm --filter @hotaru/auth-server admin:seed -- \
  --uuid aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee \
  --username LocalAdmin --login-name admin --password admin123456
```

The demo credentials are `admin` / `admin123456`. Change the password or seed a real operator account
before exposing the console.

Visual language follows the `cozy-breeze-ui` skill: sky-blue/mint palette, faint dot texture, bento
grid, soft 16px cards, pill tags, restrained motion, keyboard-visible focus, and real empty/loading/
error states. Design tokens live in `apps/admin-web/src/styles/tokens.css` and are mirrored into Naive
UI via `src/theme.ts`.

Deployment: `deploy/Dockerfile.admin-web` (nginx, SPA fallback) is wired into `deploy/compose.yaml` as
`admin-web`; Caddy serves it on `ADMIN_DOMAIN` (default `admin.$AUTH_DOMAIN`) and routes `/api/*` on
that host to the auth server, so the bundle keeps a relative `/api` and needs no CORS grant.

The user detail page lists every linked Minecraft UUID and can ban or unban one identity without touching
the account. The `/activation-codes` page issues signed account, bind and claim codes through the admin
API; it requires `ACTIVATION_PRIVATE_KEY_FILE` or `ACTIVATION_PRIVATE_KEY_PEM` on the auth server.

`/status` is a public, login-free service page. It polls `GET /api/v1/status` every five seconds and shows
Auth API, MongoDB, Redis, IRC and the console itself, with per-service latency curves. The curves are kept
in the browser for the latest 60 samples; no user data is exposed.

See [docs/admin-web.md](docs/admin-web.md) for the full rationale, screens, and known limits.

## Account API (headless)

The auth server still exposes the account lifecycle under `/api/v1/portal/*` for an external client.
This repository does not ship a user portal SPA. The endpoints cover activation, legacy claim, login,
rotating refresh tokens, email change, password reset, TOTP and UUID binding.

Activation codes use Ed25519. Generate a pair once, keep the private key on the issuing machine, and
give the auth server the public key. The admin console can issue codes only when the server also has the
private key.

```bash
pnpm --filter @hotaru/auth-server activation:code -- --keygen
pnpm --filter @hotaru/auth-server activation:code -- --type account --expires-in 7d
pnpm --filter @hotaru/auth-server activation:code -- --type bind --uuid <uuid> --username <name> --expires-in 1h
pnpm --filter @hotaru/auth-server activation:code -- --type claim --uuid <uuid> --expires-in 1d
```

`ACTIVATION_PUBLIC_KEY_FILE` or `ACTIVATION_PUBLIC_KEY_PEM` verifies codes.
`ACTIVATION_PRIVATE_KEY_FILE` or `ACTIVATION_PRIVATE_KEY_PEM` lets `/activation-codes` in the admin
console sign them.

Email password reset sends a link through `EMAIL_DELIVERY_URL`; without it the link is printed to the
auth-server log. Set `PORTAL_BASE_URL` to the external client that will consume the reset token. Without
an external client the reset endpoints remain API-only.

An unlinked UUID is rejected with `LINK_REQUIRED` and a one-time `bindingCode`; a client binds it with
`POST /api/v1/portal/bind`. A linked UUID inherits the account permissions. One account can link many
UUIDs; one UUID belongs to at most one account. Account bans cover every UUID and the account API; UUID
bans cover only that game identity.

```bash
pnpm --filter @hotaru/auth-server migrate:accounts
```

This backfills `minecraft_links` for legacy MC-only users and replaces the old non-partial unique indexes.

## Repository extras

- **`tools/e2e/smoke.mjs`** — the end-to-end harness behind the "48/48 checks" claim. It starts a fake
  Mojang session server, boots the real auth server against a throwaway database, then plays the whole
  user story with a client written independently of the server code (challenge → RSA handshake → Mojang
  join → verify → JWT → refresh → reuse detection → admin grant → ban → outage → rate limit → audit).
  Run `node tools/e2e/smoke.mjs`. `tools/e2e/fake-mojang.mjs` is its stand-in for Mojang.
- **`apps/api` + `packages/shared`** — the original pnpm-workspace scaffold (a tiny HTTP service). It is
  kept as a smoke target for `.agents/skills/verify-api/`; nothing in the auth platform imports it.
- **`docs/dev-contract.md`** — the internal contract used while building the platform in parallel (owned
  interfaces, conventions, Redis keys, wire formats, local ports). Useful when several people or agents
  work on this repo at once.

