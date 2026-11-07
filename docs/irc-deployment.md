# IRC server — deployment and operations

How the SRP v1 IRC server is built, configured, exposed and shut down, starting
with the single-node stack that `deploy/compose.yaml` describes and ending with
what changes when you need more than one instance.

- Wire protocol: [srp-v1.md](./srp-v1.md)
- REST surface: [irc-api.md](./irc-api.md)
- Storage and indexes: [irc-database.md](./irc-database.md)
- Threat model: [irc-security.md](./irc-security.md)

---

## 1. Topology (single host)

```
                    :80/:443 (published)
                          │
                       ┌──▼───┐
                       │caddy │  TLS, HTTP→HTTPS, HSTS
                       └──┬───┘
        ┌─────────────────┼──────────────────┐
   AUTH_DOMAIN       IRC_DOMAIN         ADMIN_DOMAIN
        │                 │                  │
 auth-server:3000    irc-server:3001     admin-web:80
        │                 │
        └────────┬────────┘
             internal docker network
        ┌────────┴────────┐
   mongo:27017      redis:6379
   (no host ports)  (no host ports)
```

Only Caddy publishes ports. MongoDB, Redis, the auth server and the IRC server
are reachable only on the `internal` bridge network — that is what makes
`trustProxy` (and the per-IP limits built on `X-Forwarded-For`) safe.

---

## 2. Prerequisites

1. A host with Docker Engine + Compose v2 (`docker compose version` → v2.x).
2. Three DNS records pointing at the host:
   `auth.example.com`, `admin.example.com`, `irc.example.com` (or whatever you set
   in `AUTH_DOMAIN` / `ADMIN_DOMAIN` / `IRC_DOMAIN`). Caddy needs port 80 and 443
   reachable from the internet to obtain certificates.
3. `deploy/.env` created from `deploy/.env.example`, with every `CHANGE_ME`
   replaced and all three domains set.

```bash
cp deploy/.env.example deploy/.env
$EDITOR deploy/.env
```

Minimum variables that must be set:

| Variable | Example | Purpose |
| --- | --- | --- |
| `AUTH_DOMAIN` | `auth.example.com` | auth server + JWT `iss` |
| `ADMIN_DOMAIN` | `admin.example.com` | admin console |
| `IRC_DOMAIN` | `irc.example.com` | **new**: IRC WebSocket + REST edge |
| `ACME_EMAIL` | `ops@example.com` | Let's Encrypt registration |
| `PUBLIC_BASE_URL` | `https://auth.example.com` | also becomes the IRC server's `JWT_ISSUER` |
| `MONGO_INITDB_ROOT_USERNAME` / `…_PASSWORD` | — | MongoDB credentials |
| `REDIS_PASSWORD` | — | Redis password |

The IRC-specific variables (`MONGODB_IRC_DB`, `INSTANCE_ID`, limits, …) all have
safe defaults; see §7 for the full mapping.

---

## 3. Build and start

```bash
# 1. Validate the compose model without touching Docker state
docker compose -f deploy/compose.yaml --env-file deploy/.env config -q

# 2. Start the infrastructure first (optional, but easier to read the logs)
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d mongo redis

# 3. Build and start the rest
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --build

# 4. Watch it come up
docker compose -f deploy/compose.yaml --env-file deploy/.env ps
docker compose -f deploy/compose.yaml --env-file deploy/.env logs -f irc-server caddy
```

The IRC image is built from `deploy/Dockerfile.irc-server` (multi-stage,
`node:24-alpine`, non-root `hotaru` user, production dependencies only,
`CMD ["node", "apps/irc-server/dist/server.js"]`). It builds
`@hotaru/shared-types`, `@hotaru/srp-protocol` and `@hotaru/irc-server`
in that order.

### Startup order enforced by compose

```yaml
depends_on:
  mongo:            { condition: service_healthy }   # migrations/indexes must see a live DB
  redis:            { condition: service_healthy }   # presence + dedupe + revocation
  auth-server:      { condition: service_started }   # JWKS is the trust anchor
```

The container healthcheck is `GET http://127.0.0.1:3001/health/ready`, i.e. it
only reports healthy when MongoDB **and** Redis answer.

### Verification after a deploy

```bash
curl -fsS https://irc.example.com/health/live
curl -fsS https://irc.example.com/health/ready
```

```json
{"status":"ok","uptimeSeconds":12}
{"status":"ok","checks":{"mongo":"ok","redis":"ok"},"connections":0}
```

Then drive the real transport from a machine that can reach the edge:

```bash
node tools/e2e/irc/smoke.mjs --external \
  --url wss://irc.example.com/v1/connect \
  --http https://irc.example.com \
  --auth https://auth.example.com
```

(It mints tokens through the real Minecraft flow using `TEST_ACCESSTOKEN`, or
takes `IRC_TEST_TOKEN_A` / `IRC_TEST_TOKEN_B`.)

---

## 4. The Caddy edge

`deploy/Caddyfile` adds one site block for `{$IRC_DOMAIN}`. Three things matter:

### 4.1 WebSocket upgrade

```caddyfile
@connect path /v1/connect
handle @connect {
	reverse_proxy irc-server:3001 {
		header_up X-Forwarded-For {remote_host}
		header_up X-Forwarded-Proto {scheme}
		transport http {
			dial_timeout 5s
			response_header_timeout 10s
			read_timeout 1h
			write_timeout 1h
		}
	}
}
```

- `reverse_proxy` recognises `Connection: Upgrade` + `Upgrade: websocket` itself
  and switches to a raw bidirectional tunnel; there is no `websocket` directive
  in Caddy v2.
- The long upstream `read_timeout`/`write_timeout` (1 hour) are what let a quiet
  but healthy session survive. The server's own liveness contract (ping every
  30 s, terminate after 15 s without a pong) is the thing that actually decides
  liveness; Caddy must never be the reason a session dies first.
- The global `servers { timeouts { write 30s } }` block does **not** cut upgraded
  connections: Go's `net/http` clears the connection deadline when the connection
  is hijacked, and Caddy applies the upstream transport timeouts instead.

### 4.2 REST and health

```caddyfile
handle /v1/* {   # groups, filters, presence
	encode zstd gzip
	request_body { max_size 128KB }
	reverse_proxy irc-server:3001 { … }
}
handle /health/* {
	header Cache-Control "no-store"
	reverse_proxy irc-server:3001 { … }
}
handle { respond 404 }
```

`/metrics` is deliberately **not** proxied: it is an admin-only internal endpoint
and stays reachable only from inside the Docker network.

### 4.3 Headers and logging

- HSTS (`max-age=31536000; includeSubDomains; preload`), `nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Opener-Policy: same-origin`, and no `Server` header.
- JSON access log to `/data/irc-access.log` with rotation. Caddy redacts the
  `Authorization` and `Cookie` headers to `REDACTED` by default (verified against
  `caddy:2-alpine`); query strings are logged, which is fine because SRP never
  puts a token in a URL.

Validate the file without starting Caddy:

```bash
docker run --rm \
  -e AUTH_DOMAIN=auth.example.com -e ADMIN_DOMAIN=admin.example.com \
  -e IRC_DOMAIN=irc.example.com -e ACME_EMAIL=ops@example.com \
  -v "$PWD/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
# → "Valid configuration"
```

---

## 5. Single node first

One instance is the supported v1 deployment. It keeps every guarantee in
[srp-v1.md](./srp-v1.md) true:

- fan-out is local, so DIRECT/GROUP/BROADCAST always reach every socket the node
  owns;
- presence records are written per connection but only that node's registry is
  authoritative for routing;
- the filter cache is invalidated by every local rule write, so no staleness;
- rate limits and connection caps are per node and therefore exact.

Capacity of a single node is bounded by:

| Resource | Default cap | Setting |
| --- | --- | --- |
| Concurrent sockets | 10 000 | `MAX_CONNECTIONS_TOTAL` |
| Sockets per player | 3 | `MAX_CONNECTIONS_PER_USER` |
| Sockets per IP | 20 | `MAX_CONNECTIONS_PER_IP` |
| Inbound messages | 20/s + burst 40 per socket | `MESSAGE_RATE_PER_SEC` / `MESSAGE_BURST` |
| Group messages | 10/s per socket (burst 20) | `GROUP_MESSAGE_RATE_PER_SEC` |

The IRC server creates its indexes explicitly at boot, before it starts
listening (`ensureIndexes()` in `src/infrastructure/mongo/indexes.ts`, controlled
by `MONGODB_ENSURE_INDEXES`, default `true`) — including the unique constraints
and the 30-day audit-log TTL index. This is additive and safe to run on every
boot; a constraint violation fails the boot with a clear log line instead of
silently running without uniqueness. Details and the manual `mongosh` fallback:
[irc-database.md §4.1](./irc-database.md#41-how-the-indexes-are-created).

---

## 6. Scaling out (multiple instances)

Everything that is *shared state* already lives in Redis/MongoDB. Everything that
is *socket state* does not, and that is the part v1 does not forward.

### 6.1 What already works with N replicas

| Concern | Status |
| --- | --- |
| Authentication, scopes, revocation | ✅ shared (JWKS + `auth:session:revoked:*`) |
| Dedupe / replay suppression | ✅ shared (`irc:dedupe:*` in Redis, `SET NX PX`) |
| Presence records | ✅ shared (`irc:presence:*`, keyed per connection, carries `instanceId`) |
| Groups, memberships, filters | ✅ shared (MongoDB; filters have a 5 s per-process cache) |
| REST API | ✅ stateless; any replica can serve it |
| Connection caps | ⚠️ per node (`MAX_CONNECTIONS_TOTAL` is per process) |
| **Message fan-out** | ❌ **local only** — see below |

### 6.2 What breaks

Routing looks up recipients in the **local** registry only:

```ts
const connections = deps.registry.listByUser(target);   // this process
if (connections.length === 0) → ACK failed TARGET_OFFLINE
```

With two nodes, a player connected to node B is invisible to node A, so a DIRECT
message sent through node A to that player fails with `TARGET_OFFLINE`. GROUP and
BROADCAST fan-out similarly reach only the subset of members connected to the
sending node. This is documented behaviour in
[srp-v1.md §4](./srp-v1.md#fan-out-scope), not a bug to be worked around with
sticky sessions — sticky sessions only make each player *usually* land on the same
node, they do not make cross-node fan-out correct.

### 6.3 The Phase-3 design (not implemented)

The protocol package already reserves the primitives:

```ts
presenceKeys.nodeChannel(instanceId)   // "irc:node:{instanceId}"
irc:presence:instance:{instanceId}     // which connections a node owns
```

A fan-out phase would:

1. On routing, look up the target's presence records (`irc:presence:user:{uuid}`)
   to learn which `instanceId`s own sockets for that player;
2. Publish the delivered frame to those nodes' channels (`irc:node:{instanceId}`,
   or one `irc:fanout` channel with an instance filter);
3. Each node subscribes in its own process, resolves its local registry and
   enqueues the frame to its sockets — re-applying per-recipient deny filters and
   the delivery-time TTL check that already exist in the local path;
4. Count `recipients` as the sum of the local enqueues reported back (or accept an
   approximate count, documented as such).

Because the frame that crosses Redis is the same `DeliverableMessage` with a
server-attested sender, a node must never trust the publishing node's identity
fields beyond what it already attests — the publishing node is another instance of
the same service, so the internal network is the trust boundary.

Until that exists, the honest recommendation is **one IRC replica**, scaled
vertically (nodes are cheap: fan-out is a `Map` lookup plus `socket.send`). If you
must run several replicas for availability, scope them per community/game server
so that a group's members are usually connected to the same node, and treat
`TARGET_OFFLINE` as an expected outcome across nodes.

### 6.4 Running replicas anyway

If you run N replicas behind Caddy (for rolling restarts), each **must** have a
unique `INSTANCE_ID`:

```yaml
irc-server:
  deploy: { replicas: 2 }
  environment:
    INSTANCE_ID: ${INSTANCE_ID:?unique per replica}   # irc-01, irc-02, ...
```

Duplicate `INSTANCE_ID`s make presence records collide (`irc:presence:instance:*`
and the reserved `irc:node:*` channel are keyed by it) and would make future
cross-node routing deliver to the wrong node.

Rolling restarts are safe for the same reason: a closed socket (code 1001) makes
the client reconnect to whichever replica Caddy picks next.

---

## 7. Environment variables

`apps/irc-server/src/config/env.ts` is the authoritative list. Compose maps
`${VAR}` from `deploy/.env` into the container.

| App env var | Compose source | Default | Notes |
| --- | --- | --- | --- |
| `NODE_ENV` | fixed `production` | — | also turns off Mongoose's implicit `autoIndex` |
| `HOST` / `PORT` | fixed `0.0.0.0` / `3001` | — | never published |
| `LOG_LEVEL` | `LOG_LEVEL` | `info` | pino level; tokens/payloads never logged |
| `MONGODB_URI` | built from `MONGO_INITDB_ROOT_*` | — | `?authSource=admin` |
| `MONGODB_DB` | `MONGODB_IRC_DB` | `hotaru_irc` | separate DB from the auth server |
| `MONGODB_ENSURE_INDEXES` | `MONGODB_IRC_ENSURE_INDEXES` | `true` | additive index creation at boot (unique constraints + audit TTL) |
| `REDIS_URL` | built from `REDIS_PASSWORD` | — | shared with auth server |
| `AUTH_JWKS_URL` | `AUTH_JWKS_URL` | `http://auth-server:3000/api/v1/auth/jwks` | internal DNS |
| `JWT_ISSUER` | `PUBLIC_BASE_URL` | — | **must** equal the auth server's issuer |
| `JWT_AUDIENCE` | `JWT_AUDIENCE` | `hotaru-api` | must match the token's `aud` |
| `JWKS_CACHE_TTL_MS` | `JWKS_CACHE_TTL_MS` | `600000` | parsed; `jose` caches for a fixed 10 min |
| `INSTANCE_ID` | `INSTANCE_ID` | `irc-01` | unique per replica |
| `HEARTBEAT_INTERVAL_MS` | same | `30000` | RFC 6455 ping interval |
| `PONG_TIMEOUT_MS` | same | `15000` | terminate a silent peer |
| `PRESENCE_TTL_MS` | same | `90000` | Redis presence record TTL |
| `MAX_CONNECTIONS_PER_USER` | same | `3` | 429 at upgrade |
| `MAX_CONNECTIONS_PER_IP` | same | `20` | 429 at upgrade |
| `MAX_CONNECTIONS_TOTAL` | same | `10000` | 503 at upgrade |
| `MESSAGE_RATE_PER_SEC` / `MESSAGE_BURST` | same | `20` / `40` | per-connection token bucket |
| `GROUP_MESSAGE_RATE_PER_SEC` | same | `10` | burst = 2× |
| `CREATE_GROUP_PER_HOUR` | same | `5` | per-user hourly group-creation quota (429 + `retry-after`; fails open if Redis is down) |
| `MAX_PAYLOAD_BYTES` | same | `65536` | business payload budget, enforced before routing (ERROR + ACK `PAYLOAD_TOO_LARGE`) |
| `MAX_FRAME_BYTES` | same | `131072` | enforced by `ws` `maxPayload` |
| `MAX_GROUP_MEMBERS` | same | `100` | group cap |
| `MAX_WS_BUFFERED_BYTES` | same | `1048576` | slow client → close 1013 |
| `DEDUPE_TTL_MS` | same | `120000` | replay-suppression window |
| `ADMIN_UUIDS` | `IRC_ADMIN_UUIDS` | empty | comma-separated Mojang UUIDs |
| `BROADCAST_ENABLED` | same | `true` | global kill switch |
| `CORS_ORIGINS` | `IRC_CORS_ORIGINS` | empty | **parsed, no CORS middleware** (v1 gap) |

---

## 8. Graceful shutdown

`src/server.ts` handles `SIGINT` and `SIGTERM`:

```ts
await ws.close();        // stop accepting, close every socket with 1001 "server shutting down"
await app.close();       // Fastify: stop listening, drain in-flight HTTP
await closeRedis();      // ioredis quit
await disconnectMongo(); // mongoose disconnect
process.exit(0);
```

Why this order: closing sockets first makes clients reconnect immediately to a
healthy node instead of discovering a dead TCP connection a heartbeat later.
Presence records are removed by each socket's close handler, so a clean shutdown
leaves no phantom players; a hard kill leaves records that expire after
`PRESENCE_TTL_MS` (90 s).

Docker sends `SIGTERM` and waits (default 10 s) before `SIGKILL`. Shutdown takes
milliseconds; no extra grace period is needed for a single node.

Operationally:

```bash
docker compose -f deploy/compose.yaml --env-file deploy/.env stop irc-server   # SIGTERM + wait
docker compose -f deploy/compose.yaml --env-file deploy/.env logs --tail 50 irc-server
```

Verify the contract itself from a client: on shutdown every socket must close
with code `1001`. The e2e harness does exactly that check on POSIX
(`node tools/e2e/irc/smoke.mjs`); on Windows Node cannot deliver POSIX signals, so
the harness reports that single check as `SKIP` instead of faking it.

---

## 9. Local development

```bash
# infrastructure (containers exist, just start them)
docker start hotaru-mongo hotaru-redis

# auth server on :3000 (needs Mongo + Redis)
pnpm --filter @hotaru/auth-server dev

# IRC server on :3001 (reads apps/irc-server/.env)
pnpm --filter @hotaru/irc-server dev

# end-to-end harness (hermetic: boots its own auth+irc on 3200/3201)
node tools/e2e/irc/smoke.mjs

# load check (100 clients, 10 senders × 10 messages)
node tools/e2e/irc/load.mjs
```

Ports: MongoDB `27017`, Redis `16379` (this host cannot publish 6379 — do not
"fix" it), auth `3000`, IRC `3001`, harness `3200–3203`.

---

## 10. Troubleshooting

| Symptom | Likely cause | Check |
| --- | --- | --- |
| Upgrade returns `401 UNAUTHORIZED` | token signed by another auth server, `JWT_ISSUER`/`JWT_AUDIENCE` mismatch, or JWKS unreachable | `docker compose logs irc-server`, compare `JWT_ISSUER` with `PUBLIC_BASE_URL` |
| Upgrade returns `403 SCOPE_DENIED` | token lacks `hotaru:ircserver` | decode the token's `scope` claim; grant the scope in the auth server |
| Upgrade returns `403 SESSION_REVOKED` | logout/ban/refresh-reuse revoked the session | `redis-cli GET auth:session:revoked:<sid>` |
| Upgrade returns `429` / `503 RATE_LIMITED` | connection caps (`MAX_CONNECTIONS_PER_USER`, `…_PER_IP`, `…_TOTAL`) | `/metrics` with an admin token (`connections`), `MAX_CONNECTIONS_*` |
| Upgrade returns `404 NOT_FOUND` | wrong path (must be exactly `/v1/connect`) | Caddy `handle` matchers |
| Socket closes with `1013` | slow client (send buffer over `MAX_WS_BUFFERED_BYTES`) | server log `closing slow client` with `buffered` |
| Socket closes with `1009` | frame over `MAX_FRAME_BYTES` | client-side payload size |
| Socket closes with `1001` | server shutting down / restarting | `docker compose ps`, deploy logs |
| Client reconnects every ~45 s | proxy idle timeout shorter than the heartbeat | Caddy `transport http { read_timeout write_timeout }` |
| `/health/ready` → 503 | MongoDB or Redis down | `docker compose ps`, container logs |
| Group messages stop working | MongoDB outage (readiness also 503) | `checks.mongo` in `/health/ready` |
| REST returns 500 `INTERNAL` | unexpected server fault | container log (payloads are never logged) |

---

## 11. Backups and upgrades

- **MongoDB**: the `mongo-data` volume holds groups, memberships, filters and the
  audit log. Back it up with `mongodump` against the internal network (the port is
  not published):
  ```bash
  docker compose -f deploy/compose.yaml exec mongo \
    mongodump --uri "mongodb://user:pass@127.0.0.1:27017/hotaru_irc?authSource=admin" --out /tmp/dump
  ```
- **Redis**: presence and dedupe are disposable; `auth:session:revoked:*` is the
  only security-relevant data, and losing it *extends* a revoked session until its
  token expires (15 minutes). Redis is configured with `--appendonly yes` in
  compose, which is enough for a restart, not for a disaster.
- **Upgrading the IRC image**: `docker compose … up -d --build irc-server` does a
  single-service rolling restart. Clients see `1001` and reconnect. Index
  creation runs at boot and is additive; an index *definition change* still needs
  a manual drop/recreate (see
  [irc-database.md §4.1](./irc-database.md#41-how-the-indexes-are-created)).

## Pitfall found in practice: the JWT issuer must match the auth server

The IRC server verifies `iss` against `JWT_ISSUER`, so it must be **byte-identical** to the value the auth
server signs. `PUBLIC_BASE_URL` is what the auth server puts in `iss` (unless `JWT_ISSUER` overrides it),
so mixing `http://127.0.0.1:3000` on one side with `http://localhost:3000` on the other makes every
upgrade fail with `401 UNAUTHORIZED` even though the token is valid.

Check it with:

```bash
# what the auth server signs
curl -s http://127.0.0.1:3000/api/v1/health/ready >/dev/null && \
  node -e "const t=require('./tools/e2e/.token.json').accessToken;console.log(JSON.parse(Buffer.from(t.split('.')[1],'base64url')).iss)"

# what the IRC server expects
echo $JWT_ISSUER
```

Both must print the same string. In compose, derive it from the same variable
(`JWT_ISSUER: ${PUBLIC_BASE_URL}`) so they cannot drift.