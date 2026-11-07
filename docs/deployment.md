# Deployment

This document describes how the artifacts in `deploy/` work, and what an operator has to do around
them: first boot, TLS, secrets, index creation, backups, key rotation and monitoring.

Everything below assumes a single Linux host with Docker Engine + Compose v2 (Docker Desktop works too).

- [What gets deployed](#what-gets-deployed)
- [First deployment](#first-deployment)
- [Seeding the first administrator](#seeding-the-first-administrator)
- [How the Dockerfile works](#how-the-dockerfile-works)
- [How compose.yaml works](#how-composeyaml-works)
- [How the Caddyfile works](#how-the-caddyfile-works)
- [VPS sizing](#vps-sizing)
- [TLS](#tls)
- [Secrets](#secrets)
- [Index creation and model changes in production](#index-creation-and-model-changes-in-production)
- [Backups and restore](#backups-and-restore)
- [Key rotation](#key-rotation)
- [Monitoring](#monitoring)
- [Scaling out](#scaling-out)
- [Upgrades and rollback](#upgrades-and-rollback)
- [Troubleshooting](#troubleshooting)

## What gets deployed

`deploy/compose.yaml` defines six services:

| Service | Image | Host ports | Purpose |
| --- | --- | --- | --- |
| `caddy` | `caddy:2-alpine` | `80:80`, `443:443`, `443:443/udp` | TLS termination, security headers, rate/shape limits, reverse proxy |
| `auth-server` | built from `deploy/Dockerfile` | none | the API, including the headless account and binding endpoints |
| `irc-server` | built from `deploy/Dockerfile.irc-server` | none | SRP v1 WebSocket relay and REST API |
| `admin-web` | built from `deploy/Dockerfile.admin-web` | none | admin console SPA, served by nginx |
| `mongo` | `mongo:7` | none | durable state, `--auth`, root user from `deploy/.env` |
| `redis` | `redis:7-alpine` | none | challenges, rate limits, revocation fast path, `--requirepass`, AOF on |

Only Caddy is reachable from the internet. Everything else sits on the `internal` bridge network.
Named volumes: `mongo-data`, `redis-data`, `caddy-data`, `caddy-config`.

## First deployment

Prerequisites: a DNS `A`/`AAAA` record for `AUTH_DOMAIN` pointing at the host, inbound `80` and `443`
open (Let's Encrypt needs them), and Docker + Compose v2 installed. The default admin and user portal
hosts (`admin.$AUTH_DOMAIN`, `user.$AUTH_DOMAIN`) and `IRC_DOMAIN` also need DNS records if you use them.

```bash
# 1. On the host, in the repository root
cp deploy/.env.example deploy/.env

# 2. Edit deploy/.env — every CHANGE_ME must be replaced
#    AUTH_DOMAIN, ACME_EMAIL, PUBLIC_BASE_URL, MONGO_INITDB_ROOT_PASSWORD, REDIS_PASSWORD

# 3. Build and start the whole stack
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --build

# 4. Watch it come up (first run pulls images and gets a certificate)
docker compose -f deploy/compose.yaml --env-file deploy/.env ps
docker compose -f deploy/compose.yaml --env-file deploy/.env logs -f auth-server caddy

# 5. Verify from the host
curl -fsS https://auth.example.com/api/v1/health/live
curl -fsS https://auth.example.com/api/v1/health/ready
# {"status":"ok","checks":{"mongo":"ok","redis":"ok"}}
```

Then seed an administrator (next section) before pointing players at the service. MongoDB indexes are
created automatically at boot (`MONGODB_ENSURE_INDEXES=true` by default) — see
[index creation](#index-creation-and-model-changes-in-production) for how to verify them.

`deploy/.env` is git-ignored (`.gitignore` ignores `.env` and `.env.*` except `.env.example`). Keep it
`chmod 600`.

For an external account client set `PORTAL_BASE_URL` (used in reset emails). Password reset also needs
an HTTP mail relay at `EMAIL_DELIVERY_URL`; without it reset links are printed to the auth-server log.
Admins can issue activation codes from the console only when `ACTIVATION_PRIVATE_KEY_PEM` (or
`ACTIVATION_PRIVATE_KEY_FILE` in a compose override) is present. The public key alone is enough for
redemption but cannot sign new codes.

## Seeding the first administrator

`admin:users` is not self-service: it must exist in the database before the first admin can call the
admin API.

**Local / dev database** (Mongo reachable on `127.0.0.1:27017`), from the repository root:

```bash
pnpm --filter @hotaru/auth-server admin:seed -- --uuid <minecraft-uuid> --username <name>
```

- `--uuid` accepts the dashed or undashed Mojang UUID (it is normalised).
- `--username` is required only when the account does not exist yet.
- The script loads `apps/auth-server/.env` (or the ambient environment), creates the user row if needed
  and upserts the `admin:users` grant. It is idempotent and writes the `admin.seeded` audit event.

**Production**: the runtime image installs production dependencies only and deliberately ships neither
`scripts/` nor `tsx`, so the seed script cannot run inside the `auth-server` container. Two supported
routes:

1. Run the same command from a workstation against a temporarily published database:

   ```bash
   # append to deploy/compose.yaml (temporarily, on the mongo service):
   #   ports: ["127.0.0.1:27017:27017"]
   docker compose -f deploy/compose.yaml --env-file deploy/.env up -d mongo
   MONGODB_URI='mongodb://hotaru:<password>@127.0.0.1:27017/?authSource=admin' \
     pnpm --filter @hotaru/auth-server admin:seed -- --uuid <uuid> --username <name>
   # then remove the port mapping and re-apply
   ```

2. Insert the two documents directly with `mongosh` (no shell-out to Node required):

   ```javascript
   mongosh "mongodb://hotaru:<password>@127.0.0.1:27017/hotaru_auth?authSource=admin" --eval '
     const uuid = "<minecraft-uuid>";
     const name = "<username>";
     const now = new Date();
     const user = db.users.findOneAndUpdate(
       { minecraftUuid: uuid },
       { $set: { username: name, status: "active", banReason: null, bannedAt: null, lastLoginAt: null },
         $setOnInsert: { createdAt: now, updatedAt: now } },
       { upsert: true, returnDocument: "after" }
     );
     db.permissions.updateOne(
       { userId: user._id, scope: "admin:users" },
       { $set: { expiresAt: null, grantedBy: "system:seed-admin", updatedAt: now },
         $setOnInsert: { userId: user._id, scope: "admin:users", createdAt: now } },
       { upsert: true }
     );
     db.audit_logs.insertOne({
       event: "admin.seeded", actorId: null, actorType: "system", targetType: "user",
       targetId: String(user._id), ip: null,
       metadata: { minecraftUuid: uuid, scopes: ["admin:users"] }, createdAt: now
     });
   '
   ```

Either way, the administrator then logs in through the normal Minecraft handshake and their access token
carries `admin:users` (recomputed from the database on the next request).

## How the Dockerfile works

`deploy/Dockerfile` is a two-stage build with the repository root as context (`context: ..` in compose):

```
stage build   (node:24-alpine)
  ENV CI=true                                                        → no interactive pnpm prompts
  corepack enable && corepack prepare pnpm@11.12.0 --activate
  COPY the four manifests + the three workspace package.json files   → cached dependency layer
  pnpm install --frozen-lockfile                                     → exact lockfile, no drift
  COPY tsconfig.base.json, packages/, apps/auth-server/
  pnpm --filter @hotaru/shared-types build
  pnpm --filter @hotaru/api-contract build
  pnpm --filter @hotaru/auth-server build                         → tsc → apps/auth-server/dist
  pnpm install --prod --frozen-lockfile --ignore-scripts             → production dependency graph only

stage runtime (node:24-alpine)
  addgroup/adduser hotaru (unprivileged)
  COPY /app/node_modules                                             (root dependency graph)
  COPY /app/packages, /app/apps/auth-server                          whole, so each package keeps
                                                                     its own node_modules symlinks
  USER hotaru
  EXPOSE 3000
  HEALTHCHECK node -e "fetch('http://127.0.0.1:3000/api/v1/health/live')…"
  CMD ["node", "apps/auth-server/dist/server.js"]
```

Notes:

- **Why a second `pnpm install --prod` instead of `pnpm prune --prod`.** Inside a workspace, `prune`
  leaves each package's `node_modules` without its dependency symlinks (and, without `CI=true`, refuses
  to purge at all). The runtime image then dies at boot with
  `ERR_MODULE_NOT_FOUND: Cannot find package 'zod'`. A fresh `--prod` install rebuilds the correct symlink
  graph with only production dependencies.
- **Why whole workspace directories are copied.** A package's dependency symlinks live in its *own*
  `node_modules`, and a package with no dependencies (for example `packages/shared-types`) has no
  `node_modules` directory at all — a granular `COPY .../node_modules` fails with "not found". Copying
  `packages/` and `apps/auth-server/` whole is the robust form.
- **The runtime image keeps the sources** (`src/`, `tsconfig`-independent) because they come with those
  whole-directory copies. It contains **no toolchain**: no `tsc`, no `tsx`, no test runner, no
  `scripts/`. Consequences:
  - it cannot recompile anything at boot;
  - `admin:seed` cannot run inside the container — seed from a workstation or with `mongosh`
    (see [seeding](#seeding-the-first-administrator));
  - it runs as the unprivileged `hotaru` user, and `node` never runs as root.
- The build fails loudly on a TypeScript error (`tsc`, no `noEmitOnError` bypass). `pnpm install
  --frozen-lockfile` fails if `pnpm-lock.yaml` is stale — commit lockfile changes with code changes.
- The image's own `HEALTHCHECK` is for `docker run` outside compose; inside compose, the compose
  `healthcheck` (readiness via `/api/v1/health/ready`) takes precedence.
- Never "optimise" the image by reintroducing `pnpm prune --prod` or by copying `node_modules`
  granularly — both were measured and both break boot.

## How compose.yaml works

- **Configuration interpolation.** Every secret is read from `deploy/.env` via
  `${VAR:?set in deploy/.env}` (fails fast if missing) or `${VAR:-default}` (sane default). The app
  container is given exactly the variables `src/config/env.ts` understands — 27 of them, verified
  (including `MONGODB_ENSURE_INDEXES`, which `deploy/.env.example` documents).
- **Connection strings.** `MONGODB_URI` and `REDIS_URL` are built from the same passwords Mongo/Redis
  are started with, so they cannot drift. Passwords are interpolated verbatim into URLs — see
  [Secrets](#secrets).
- **Startup ordering.** `auth-server` waits for `mongo` and `redis` `service_healthy`;
  `caddy` starts after `auth-server` started. Mongo's healthcheck authenticates with the root user,
  Redis's pings with the password.
- **No host ports for the app.** `auth-server:3000` is only reachable as `auth-server:3000` on the
  internal network, which is exactly what Caddy proxies to.
- **Restart policy** is `unless-stopped` everywhere: a crashed service restarts, a deliberately stopped
  stack stays down.
- **Volumes** persist Mongo data, Redis AOF, and Caddy certificates/state. Losing `caddy-data` means a
  new certificate request (rate-limited by Let's Encrypt); losing `mongo-data` means losing users,
  sessions and the audit trail.

## How the Caddyfile works

```caddyfile
{ email {$ACME_EMAIL}  servers { timeouts { read_body 10s read_header 10s write 30s idle 120s } } }
{$AUTH_DOMAIN} { … }
```

| Directive | Why |
| --- | --- |
| `email {$ACME_EMAIL}` | ACME account for automatic Let's Encrypt certificates and expiry notices. |
| `servers > timeouts` | `read_body` 10 s, `read_header` 10 s, `write` 30 s, `idle` 120 s — the option names are `read_body`/`read_header`/`write`/`idle` (**not** `*_timeout`; `caddy validate` rejects those). |
| `encode zstd gzip` | JSON responses compress well; Minecraft clients are usually on slow links. |
| `request_body { max_size 64KB }` | auth payloads are a few KB; refuse oversized bodies before the app sees them. |
| `header { Strict-Transport-Security, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Cross-Origin-Opener-Policy, -Server }` | HTTPS-only, no sniffing, no framing, no referrer leakage, no version banner. |
| `log { output file /data/access.log … format json }` | Access log in the `caddy-data` volume, rotated at 10 MB × 5. Caddy redacts `Authorization` and `Cookie` automatically; it **does** record query strings, so never put secrets in a query string. |
| `reverse_proxy auth-server:3000` | Plain HTTP on the internal network. `dial_timeout 5s`, `response_header_timeout 15s` leave room for the app's own Mojang timeout to fire first. |
| `@health path /api/v1/health/*` + `Cache-Control: no-store` | Health answers must never be cached by a CDN/proxy in front. |
| `@docs path /docs /docs/*` + `respond @docs 404` | Swagger UI ships in the app but is not publicly exposed. |

`header_up X-Forwarded-For {remote_host}` / `X-Forwarded-Proto {scheme}` are redundant on Caddy 2.8+
(it sets both itself) but harmless, and the explicit XFF override is intentional: the edge replaces any
client-supplied chain, so `clientIp()` in `src/http/zod-schema.ts` reads the real peer address.

Validate any edit before reloading:

```bash
docker compose -f deploy/compose.yaml --env-file deploy/.env run --rm --no-deps \
  -v "$PWD/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" caddy \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

## VPS sizing

The workload is small: JSON payloads of a few KB, one RSA decrypt and one Mojang call per login, three
indexed Mongo lookups per authenticated request.

| Players (concurrent logins / total) | vCPU | RAM | Disk | Notes |
| --- | --- | --- | --- | --- |
| up to ~100 | 1 | 2 GB | 20 GB SSD | Add 2 GB swap. Mongo cache is capped at 0.5 GB by `--wiredTigerCacheSizeGB 0.5`. |
| ~500–1 000 | 2 | 4 GB | 40 GB SSD | Comfortable. Ship logs off-host. |
| 1 000–5 000 | 2–4 | 8 GB | 80 GB SSD | Raise the WiredTiger cache, enable Mongo authentication/backups as below, consider a second replica behind Caddy. |

The database stays small: a user row is a few hundred bytes; a session plus its refresh token is under a
kilobyte. Ten thousand players with a week of sessions is on the order of tens of megabytes, plus audit
logs (180-day retention).

## TLS

- Certificates are obtained automatically per hostname by Caddy (ACME HTTP-01 or TLS-ALPN-01) and
  renewed in the background; state lives in the `caddy-data` volume. Do not delete that volume casually.
- Requirements: `AUTH_DOMAIN` resolves to this host, ports 80/443 are reachable, `ACME_EMAIL` is a real
  mailbox.
- `PUBLIC_BASE_URL` (and therefore `JWT_ISSUER`) must be the `https://` origin — the issuer claim is
  part of every token's validity check.
- Experimenting with Let's Encrypt rate limits? Add `acme_ca https://acme-staging-v02.api.letsencrypt.org/directory`
  to the global Caddy block, and restart Caddy after removing it.
- Terminating TLS somewhere else (cloud LB)? Then point it at Caddy's 443 or swap Caddy for the
  provider's proxy — but keep the same headers (`X-Forwarded-For`/`-Proto`) and the 64 KB body cap.

## Secrets

Three kinds of secret live in `deploy/.env`:

1. **Database/Redis passwords** — `MONGO_INITDB_ROOT_PASSWORD`, `REDIS_PASSWORD`.
2. **Key material (optional)** — `JWT_PRIVATE_KEY_PEM`, `JWT_PUBLIC_KEY_PEM`,
   `MINECRAFT_RSA_PRIVATE_KEY_PEM`, `MINECRAFT_RSA_PUBLIC_KEY_PEM`.
3. **Pseudo-secrets** — `AUTH_DOMAIN`, `ACME_EMAIL`, `PUBLIC_BASE_URL`.

**Passwords must be URL-safe: no `@`, `:`, `/`, `#`, `?` or `%`.** `compose.yaml` interpolates them
verbatim into `MONGODB_URI` (`mongodb://user:password@mongo:27017/…`) and `REDIS_URL`
(`redis://:password@redis:6379`). A password containing those characters breaks the URI (and therefore
the boot) in ways that look like an authentication failure. Generate with:

```bash
openssl rand -base64 32 | tr -d '/+=' | cut -c1-32   # alphanumeric, URL-safe, 32 chars
```

(MongoDB does accept percent-encoded passwords in a URI, but the compose interpolation would have to
encode them, which it does not.)

**PEMs.** `compose.yaml` forwards all four variables to the app container (as `${VAR:-}`), so defining
them in `deploy/.env` — or exporting them before `docker compose up` — is enough; nothing else to wire.
When they are empty (the default), the service generates each key pair once and persists it in the
`service_keys` collection, so restarts and replicas agree. Setting them (e.g. injected from a
KMS/secret manager) keeps the private keys out of the database. Both variables of a pair must be
supplied together — a half-configured pair is silently ignored and the service falls back to MongoDB.

## Index creation and model changes in production

`connectMongo()` sets `autoIndex: nodeEnv !== 'production'`, so Mongoose never builds indexes on boot in
production. Instead, `server.ts` calls `ensureIndexes()` (`src/infrastructure/mongo/indexes.ts`), which
runs `Model.createIndexes()` for all eight models when `MONGODB_ENSURE_INDEXES` is `true` (the default,
and what `deploy/.env.example` + `compose.yaml` ship).

Why this matters: three of those indexes are **correctness constraints**, not tuning —
`users.minecraftUuid` (unique), `permissions(userId, scope)` (unique) and
`refresh_tokens.tokenHash` (unique). Without them a fresh database could accept duplicate grants or
duplicate sessions. `createIndexes()` is additive: it creates what is missing and never drops an index
that exists in the database but not in the schema, so it is safe on every boot and on an existing
deployment with operator-added indexes.

Operational rules:

1. **Nothing to do on first boot.** Start the stack; the indexes are created before the app answers
   traffic. Verify once with:

   ```bash
   docker compose -f deploy/compose.yaml --env-file deploy/.env exec mongo \
     mongosh -u "$MONGO_USER" -p --authenticationDatabase admin hotaru_auth \
     --eval 'db.users.getIndexes().map(i => i.name)'
   ```

2. **Model changes ship with a restart.** Add a `schema.index(...)` line, deploy, and the next boot
   creates it. There is no migration framework: keep changes **additive and backward compatible** (add
   an optional field with a default; never rename a field the previous version still reads), deploy the
   tolerant code first, backfill with `mongosh` afterwards if needed.
3. **If boot-time creation is undesirable** (very large collection, maintenance window, restricted
   credentials), set `MONGODB_ENSURE_INDEXES=false` and create the indexes by hand with the `mongosh`
   block in [database.md](database.md#index-creation-in-production). Repairing a restore or a drifted
   environment is the same operation.
4. **Never drop an index the code relies on** while the service is live: the guard's session/user
   lookups, the refresh-token lookup and the admin search all assume their indexes exist. A missing
   index turns an O(1) lookup into a collection scan under production load.

## Backups and restore

What must be backed up: **`mongo-data`** (users, permissions, sessions, refresh tokens, audit log, and —
if you did not inject PEMs — the service keys). Redis needs no backup: challenges, rate limits and
revocation keys are ephemeral by design, and the session document is authoritative.

```bash
# Dump (run daily via cron/systemd timer)
docker compose -f deploy/compose.yaml --env-file deploy/.env exec -T mongo \
  mongodump --uri "mongodb://$MONGO_USER:$MONGO_PASSWORD@127.0.0.1:27017/?authSource=admin" \
  --archive --gzip > /backup/hotaru-auth-$(date +%F).gz

# Restore (stop the app first so nothing writes during the restore)
docker compose -f deploy/compose.yaml --env-file deploy/.env stop auth-server
docker compose -f deploy/compose.yaml --env-file deploy/.env exec -T mongo \
  mongorestore --uri "mongodb://$MONGO_USER:$MONGO_PASSWORD@127.0.0.1:27017/?authSource=admin" \
  --archive --gzip --drop --nsInclude 'hotaru_auth.*' < /backup/hotaru-auth-2026-11-06.gz
docker compose -f deploy/compose.yaml --env-file deploy/.env start auth-server
```

- Restore into a scratch database and boot a test instance against it at least once a quarter.
- Keep backups off-host. A backup in the same volume as the data is not a backup.
- If you injected PEMs from a secret manager, back up the secret store too; otherwise a restored
  database that lacks `service_keys` will generate new keys and every client must re-authenticate.
- Re-create indexes after a restore if the dump did not include them (`mongodump` includes index
  definitions; `--nsInclude` with `--drop` restores them).
- Encrypt backups at rest (they contain session hashes and the audit trail).

## Key rotation

Two independent pairs exist: **Ed25519 (JWT)** and **RSA-1024 (Minecraft handshake)**.

| Pair | Where it can live | Rotation impact |
| --- | --- | --- |
| JWT Ed25519 | env PEMs or `service_keys` | All unexpired access tokens immediately fail verification (`kid` changes). Clients must use `/auth/refresh` (refresh tokens are opaque and unaffected) or log in again. Services caching JWKS must re-fetch. |
| Minecraft RSA-1024 | env PEMs or `service_keys` | New challenges advertise the new public key; clients that cached the old one must take the key from the next challenge response. In-flight challenges fail the hash (they die within 60 s anyway). |

Procedure (env PEMs, recommended):

```bash
# 1. Generate a new pair locally, never on the server and never in a log
openssl genpkey -algorithm ed25519 -out jwt-private.pem
openssl pkey -in jwt-private.pem -pubout -out jwt-public.pem
openssl genrsa -out mc-private.pem 1024
openssl rsa -in mc-private.pem -pubout -out mc-public.pem

# 2. Put both PEMs of a pair into deploy/.env (multi-line values need to be single-line,
#    which PEMs are not — so inject via a secret file/manager, e.g. docker secrets, or
#    export them into the environment before `docker compose up`)
# 3. Restart only the app
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --force-recreate auth-server
# 4. Verify
curl -fsS https://auth.example.com/api/v1/auth/jwks | jq '.keys[0].kid'
```

Operational notes:

- There is **no dual-key overlap window** today: JWKS publishes exactly one key, so rotation is an
  atomic "everyone re-authenticates" event. Scheduled rotations are therefore a maintenance-window
  activity, not a routine one.
- Rotating the Minecraft key while `service_keys` holds the old one is safe only if both PEM variables
  are set; otherwise the service keeps using the database copy.
- If a private key is believed to be exposed, rotate first and investigate second; every token minted by
  the old key must be treated as untrusted.
- Never rotate by deleting the `service_keys` documents on a live cluster: replicas that restart at
  different instants would briefly disagree on the signing key.

## Monitoring

**Liveness/readiness**

- `GET /api/v1/health/live` — process is up; never touches dependencies (safe for restart policies).
- `GET /api/v1/health/ready` — `200 {"status":"ok"}` only when MongoDB **and** Redis answer; `503
  {"status":"degraded","checks":{…}}` otherwise. Point load balancers and external uptime checks here.

**Logs**

- auth-server: structured JSON (pino) on stdout, level `LOG_LEVEL`. `Authorization` and `Cookie`
  headers are redacted at the logger level; request bodies are never logged.
- caddy: JSON access log in the `caddy-data` volume (`/data/access.log`), rotated 10 MB × 5. Caddy
  redacts `Authorization`/`Cookie`; query strings are recorded.
- Ship both off-host (`journald` → Loki/CloudWatch or a log agent) and keep 30–90 days.

**Suggested alerts**

| Signal | Meaning | Suggested action |
| --- | --- | --- |
| `/api/v1/health/ready` not `200` for > 2 min | Mongo or Redis down | Check `docker compose ps`, container logs, disk |
| `auth.refresh.reused` audit events > 0 in a day | Refresh-token theft or buggy client refresh concurrency | Investigate the actor/session; verify the SDK single-flights refresh |
| `auth.challenge.rejected` spike (reason `not_premium_session`) | Credential-stuffing / forged handshakes | Tighten `RATE_LIMIT_*_MAX`, add edge rate limiting |
| `429` rate on challenge/verify rising | Abuse or misconfigured client | Inspect `auth:rate:*` keys, adjust limits |
| `MOJANG_UNAVAILABLE` spike | Mojang outage | Status page; nothing to fix locally (fail-closed is working) |
| Mongo disk usage growth | Audit log retention or a leak | Check TTL indexes exist (`db.audit_logs.getIndexes()`) |
| `service_keys` count ≠ 2 | Key material was deleted/duplicated | Investigate before restarting replicas |
| Caddy certificate renewal errors | DNS/port 443 broken | `docker compose logs caddy`; check ACME errors |
| Container restarts > 1/h | Crash loop (bad config, OOM) | `logs auth-server`; a config error prints an aggregated validation message |

**Audit trail** — query it via the API rather than the database:

```bash
curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" \
  'https://auth.example.com/api/v1/admin/audit-logs?event=auth.refresh.reused&limit=50'
```

## Scaling out

- The HTTP tier is stateless: `docker compose up --scale auth-server=3` works as long as **all replicas
  share the same key material** (env PEMs, or the same `service_keys` collection — which they do by
  default) and point at the same Mongo and Redis.
- No sticky sessions are needed: there is no in-process session state.
- Redis is the rate-limit/challenge store, so it becomes the shared limiter across replicas
  automatically.
- For heavier loads, add a Caddy upstream pool (`reverse_proxy auth-server:3000` → Docker DNS round-robin
  already distributes across replicas with the same service name).

## Upgrades and rollback

```bash
git pull
docker compose -f deploy/compose.yaml --env-file deploy/.env build auth-server
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d auth-server
docker compose -f deploy/compose.yaml --env-file deploy/.env ps
curl -fsS https://auth.example.com/api/v1/health/ready
```

- Rollback = rebuild the previous commit and `up -d` again. Sessions survive (they are in MongoDB), but
  **access tokens minted with a different key pair do not** — see [Key rotation](#key-rotation).
- Environment variable changes require `up -d --force-recreate auth-server` (compose re-creates on
  config change, but force-recreate is the reliable form).
- Never change `MONGODB_DB` on a live deployment unless you intend to point at an empty database.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `auth-server` exits immediately, log shows `Invalid environment configuration:` | A required variable is missing/typo'd (`MONGODB_URI`, `REDIS_URL`, bad URL) | Compare `deploy/.env` with `deploy/.env.example` |
| `auth-server` restarts with `MongoServerSelectionError` | Wrong root password, or Mongo not healthy yet | `docker compose logs mongo`; check `MONGO_INITDB_ROOT_*` matches `MONGODB_URI` |
| `NOAUTH Authentication required` in Redis | `REDIS_PASSWORD` changed without re-creating Redis with the same value | Set the password consistently; recreate both services |
| Browser/curl gets `502` from Caddy | `auth-server` unhealthy or still starting | `docker compose ps`, `logs auth-server`, then `/api/v1/health/ready` |
| Certificate not issued | DNS not pointing here, ports 80/443 blocked, or rate limit | `docker compose logs caddy`; verify `dig +short $AUTH_DOMAIN` |
| `caddy` crash-loops with `unrecognized timeouts option` | A Caddyfile edit reintroduced `read_timeout`/`write_timeout` | Use `read_body`/`read_header`/`write`/`idle` |
| `/api/v1/health/ready` is `503` with `{"mongo":"ok","redis":"fail"}` | Redis password mismatch or Redis down | `docker compose logs redis`; re-check `REDIS_URL` |
| Every login returns `503 MOJANG_UNAVAILABLE` | Host cannot reach `sessionserver.mojang.com` (egress firewall/DNS) | `docker compose exec auth-server node -e "fetch('https://sessionserver.mojang.com').then(r=>console.log(r.status))"` |
| `404` on `/docs` | Correct: the Caddyfile blocks Swagger UI in production | Use `docs/openapi.json` or run locally |
