# Architecture

The MC Auth Platform is the identity provider for the Skymatrix Minecraft servers. It answers one
question — *"is this player really the premium Minecraft account they claim to be, and what are they
allowed to do?"* — and it answers it without ever holding a Mojang access token.

The service is `apps/auth-server`: a Fastify 5 application in TypeScript, backed by MongoDB (durable
state), Redis (ephemeral state) and the public Mojang session server (premium proof).

- [Why a modular monolith](#why-a-modular-monolith)
- [Module map](#module-map)
- [Runtime topology](#runtime-topology)
- [Request lifecycle](#request-lifecycle)
- [Boot lifecycle](#boot-lifecycle)
- [Where the state lives](#where-the-state-lives)
- [The three trust domains](#the-three-trust-domains)
- [Failure philosophy](#failure-philosophy)
- [Why this shape scales](#why-this-shape-scales)

## Why a modular monolith

The platform is one deployable process, not a fleet of microservices. The reasons are concrete:

1. **Every authentication decision needs the same three dependencies.** A verification needs Redis
   (challenge + rate limit), MongoDB (user, session) and Mojang (session proof). Splitting them into
   services would turn one in-process function call into three network hops on the hottest path we
   have — login.
2. **The security invariants are cross-cutting.** "Fail closed", "one-time challenge consumption" and
   "never trust a client claim" are properties of the whole flow. Keeping the flow in one process keeps
   those invariants reviewable in one pull request.
3. **One team, one deploy.** A monorepo with a single artifact (`apps/auth-server`) means one version,
   one migration story, one log stream. Microservices here would buy isolation we do not need and pay
   for it with distributed-systems failure modes we do not want next to our auth path.
4. **The modules are already separable.** Every module is a plain async `registerXxxRoutes(app, ctx)`
   function and depends only on the `AppContext` (`src/context.ts`) and foundation code. Nothing reads
   globals. If a module ever needs to become a service, the seam is already a function boundary.

The escape hatch is deliberate: `AppContext` (`config`, `keys`, `redis`) is passed explicitly rather
than decorated onto modules, so a module can be unit-tested with a fake context and lifted out later
without a rewrite.

## Module map

Everything lives in `apps/auth-server/src`.

| Path | Responsibility | Talks to |
| --- | --- | --- |
| `server.ts` | Boot: config → Mongo → Redis → keys → app → `listen`; graceful shutdown on SIGINT/SIGTERM | all infrastructure |
| `app.ts` | Builds the Fastify instance, registers plugins and every route module, exposes `/api/v1/auth/jwks` | route modules |
| `context.ts` | `AppContext { config, keys, redis }` — the only thing a route module is given | — |
| `config/env.ts` | Parses and validates `process.env` with Zod; fails fast with an aggregated error | dotenv |
| `errors.ts` | `AppError` + the `Errors.*` factory; one machine-readable code per failure | — |
| `http/zod-schema.ts` | Zod → OpenAPI JSON Schema, plus `clientIp()` / `userAgentOf()` helpers | zod-to-json-schema |
| `plugins/errors.ts` | Global error handler and 404 handler; the only place an error envelope is built | — |
| `plugins/auth.ts` | The `authenticate()` guard: JWT verification plus live DB re-derivation of authority | Mongo, Redis |
| `infrastructure/mongo/**` | Mongoose connection and the eight document models | MongoDB |
| `infrastructure/redis/client.ts` | Singleton ioredis client, `pingRedis()`, `closeRedis()` | Redis |
| `infrastructure/crypto/keys.ts` | Ed25519 JWT pair + RSA-1024 Minecraft pair; env PEMs win, otherwise generate-once-and-persist | Mongo (`service_keys`) |
| `infrastructure/crypto/server-hash.ts` | Vanilla-compatible Minecraft server hash (signed SHA-1 hex) | — |
| `infrastructure/mojang/client.ts` | `hasJoined()` — the premium-session proof, with bounded retries | Mojang |
| `modules/health/routes.ts` | `/api/v1/health/live` (no dependencies) and `/api/v1/health/ready` (Mongo + Redis) | Mongo, Redis |
| `modules/minecraft-auth/**` | Challenge creation and verification (the RSA handshake) | Redis, Mojang |
| `modules/tokens/**` | Session creation, Ed25519 access tokens, refresh rotation, logout | Mongo, Redis |
| `modules/users/**` | `/users/me` and `/users/me/permissions`; shared view mappers used by admin | Mongo |
| `modules/admin/**` | User search, permission replacement, ban/unban, session revocation, audit log | Mongo, Redis |
| `modules/audit/**` | `recordAudit()` — best-effort persistence of security events | Mongo |
| `scripts/export-openapi.ts` | Builds the app with an in-memory context and writes `docs/openapi.json|yaml` | — |
| `scripts/seed-admin.ts` | Grants `admin:users` to a Minecraft UUID; idempotent | Mongo |

Dependency direction is one-way: `routes → service → infrastructure`. A module may call another
module's *service* (`admin` → `users/service`, `tokens` → `audit/service`); no module reaches into
another module's internals, and nothing outside `app.ts` imports a `routes.ts`.

### Supporting packages

| Path | Purpose |
| --- | --- |
| `packages/shared-types` | Pure domain vocabulary: `SCOPES`, `ERROR_CODES`, `AccessTokenClaims`, view interfaces. No runtime dependencies. |
| `packages/api-contract` | Zod schemas for every request/response plus `toJsonSchema()`-compatible contracts. The single source of truth for the wire format. |
| `clients/skymatrix-sdk-java` | Dependency-free Java client for the handshake (RSA-1024 PKCS#1 v1.5 + server hash), used by the Fabric mod. |
| `tools/e2e` | Fake Mojang server + full user-story smoke test used for verification. |

`apps/api` is the leftover monorepo scaffold service (`/health` + a hello route). It is not part of the
auth platform and is not deployed.

## Runtime topology

```
                        ┌──────────────────────────────────────────┐
   Minecraft client     │  deploy/Caddyfile                        │
   (Fabric mod +        │  TLS 1.3, HSTS, 64 KB body cap,          │
    skymatrix-sdk-java)    │  /docs blocked, access log without tokens │
          │             └───────────────────┬──────────────────────┘
          │ HTTPS :443                      │ HTTP over private Docker network
          ▼                                 ▼
   ┌───────────────────────────────────────────────────────────────┐
   │  auth-server  (Fastify, :3000)                                │
   │                                                               │
   │   routes ──► services ──► infrastructure                      │
   │                              │                                │
   └──────────────┬───────────────┼────────────────────┬───────────┘
                  │               │                    │
        ┌─────────▼──────┐  ┌─────▼──────────┐  ┌──────▼─────────────┐
        │ MongoDB 7      │  │ Redis 7        │  │ Mojang session API │
        │ users,         │  │ challenges,    │  │ hasJoined          │
        │ sessions,      │  │ rate counters, │  │ (public internet)  │
        │ refresh tokens,│  │ revocation     │  │                    │
        │ permissions,   │  │ fast-path keys │  │                    │
        │ audit, keys    │  │                │  │                    │
        └────────────────┘  └────────────────┘  └────────────────────┘
```

Only Caddy publishes host ports (80/443). MongoDB, Redis and the auth server listen on the internal
Docker network only — see [deployment.md](deployment.md).

## Request lifecycle

For a protected business route (for example `GET /api/v1/users/me`):

```
1. TCP/TLS terminates at Caddy                      → X-Forwarded-For / -Proto set
2. Fastify: trustProxy=true                         → request.ip is the real client
3. Plugins already registered: cors, swagger, swagger-ui, error handler
4. Route matched; body parsed, capped at 64 KiB
5. preHandler authenticate()                        → plugins/auth.ts
   a. Read `Authorization: Bearer <token>`
   b. jwtVerify(EdDSA, issuer, audience)            → TOKEN_EXPIRED / UNAUTHORIZED
   c. Load user; check status                       → USER_BANNED (checked before session
                                                      state so a ban never reads as a 401)
   d. EXISTS auth:session:revoked:{sid}             → SESSION_REVOKED (Redis fast path)
   e. Load session; check revokedAt + expiresAt     → SESSION_REVOKED
   f. Load permissions, filter unexpired            → scopes
   g. Check required scopes                         → FORBIDDEN
   h. request.auth = { userId, minecraftUuid, username, sessionId, jti, scopes }
6. Handler → module service → Mongoose / ioredis / Mojang
7. Response serialised against the route's JSON Schema
8. Any throw → plugins/errors.ts → { error: { code, message, retryable, details? } }
```

Two properties matter here:

- **Authority is never taken from the token.** Step (f) recomputes scopes from MongoDB on *every*
  request, so a revoked permission or a ban takes effect on the next call rather than at token expiry.
  The `scope` claim in the JWT is informational only.
- **The revocation check is two-layered.** Redis is the cheap fast path; the `sessions` document is
  authoritative. If Redis loses a key, the session check still wins.

## Boot lifecycle

`src/server.ts` boots strictly in dependency order and refuses to start half-configured:

```
loadConfig()            throws one aggregated error listing every invalid variable
connectMongo()          serverSelectionTimeoutMS: 5s, pool 20, autoIndex off in production
ensureIndexes()         only when MONGODB_ENSURE_INDEXES=true (default): additive
                        Model.createIndexes() for all eight models — unique constraints
                        must exist before the first request (see database.md)
createRedis()           ioredis, offline queue disabled, 5s connect timeout
initKeys()              env PEMs, else load from `service_keys`, else generate + persist
buildApp(ctx)           registers plugins and all route modules
app.listen()            HOST/PORT from config
```

Any failure above is fatal (`process.exit(1)`): an auth service with a broken backend must not accept
traffic. Shutdown closes Fastify, then Redis, then Mongo, on SIGINT/SIGTERM.

## Where the state lives

| State | Store | Lifetime | Why there |
| --- | --- | --- | --- |
| Pending challenge | Redis `auth:challenge:{id}` | `CHALLENGE_TTL_SECONDS` (default 60 s) | One-shot, short-lived, must be atomic (`GETDEL`); losing it is safe |
| Rate-limit counters | Redis `auth:rate:ip:{ip}`, `auth:rate:uuid:{uuid}` | `RATE_LIMIT_WINDOW_SECONDS` | Cheap, shared across instances, self-expiring |
| Revocation fast path | Redis `auth:session:revoked:{sid}` | until the access token expires | Turns a Mongo read into a Redis `EXISTS` on the hot path |
| Users, permissions, admins | MongoDB | permanent | Source of truth for identity and authority |
| Sessions | MongoDB `sessions` | `REFRESH_TOKEN_TTL_DAYS` | Must stay queryable for the whole token lifetime |
| Refresh tokens (hashes) | MongoDB `refresh_tokens` | session lifetime | Rotation and reuse detection need durable state |
| Audit trail | MongoDB `audit_logs` | 180 days (TTL) | Security forensics |
| Service keys | `service_keys` collection **or** env PEMs | permanent | Multiple instances must agree on JWKS and the Minecraft public key |

Details and index rationale: [database.md](database.md).

## The three trust domains

```
   ┌────────────────────┐        ┌──────────────────────┐        ┌───────────────────┐
   │   MOJANG           │        │   OUR SERVICE        │        │   OUR CLIENTS     │
   │                    │        │                      │        │                   │
   │  proves: "this     │───────►│  decides: session,   │───────►│  present the JWT, │
   │  account owns an   │  only  │  scopes, bans        │  JWT   │  never the        │
   │  active session"   │  input │                      │        │  Minecraft token  │
   └────────────────────┘  we    └──────────────────────┘        └───────────────────┘
                        trust for
                        identity
```

- **Identity** comes exclusively from Mojang (`hasJoined`). A client-supplied UUID is a *lookup key*
  for the challenge, never proof of identity.
- **Authority** comes exclusively from our MongoDB (`users.status`, `permissions`). It is recomputed
  per request.
- **Credentials** are ours: Ed25519 access tokens and opaque, hashed refresh tokens. The Mojang access
  token never leaves the client — see [security.md](security.md).

## Failure philosophy

| Situation | Behaviour | Code |
| --- | --- | --- |
| Mojang returns no session (204/4xx) | Negative verification, no retry storm | `NOT_A_PREMIUM_SESSION` |
| Mojang unreachable / 5xx / timeout | Retry per config, then fail closed | `MOJANG_UNAVAILABLE` (retryable) |
| Redis unreachable | Challenge cannot be created → request fails closed | 5xx `INTERNAL` |
| Redis loses a revocation key | Session document still revokes | `SESSION_REVOKED` |
| Mongo unreachable | Readiness fails; requests fail closed | 5xx |
| Ambiguous refresh-token state | Deny and revoke the session | `REFRESH_REUSED` |

There is no "degraded but permissive" mode anywhere in the authentication path.

## Why this shape scales

- **Stateless HTTP tier.** All state is in Mongo/Redis, so auth-server replicas can be added behind
  Caddy without sticky sessions. The only shared-secret requirement is the key pair (env PEM or
  `service_keys`).
- **Hot path cost.** A verified request is one Ed25519 verification, one Redis `EXISTS`, and one
  Mongo round-trip for session+user+permissions (all indexed lookups).
- **Login cost.** A login is one Redis `GETDEL` plus one Mojang HTTP call (bounded by
  `MOJANG_HAS_JOINED_TIMEOUT_MS` and `MOJANG_HAS_JOINED_ATTEMPTS`), plus a handful of small writes.
- **Failure isolation.** A Mojang outage only breaks *new logins*; already-issued access tokens keep
  working until they expire (and refresh keeps working, because refresh never calls Mojang).
