# IRC server — security model and threat analysis

Scope: the SRP v1 WebSocket endpoint, the IRC REST API, and the storage they
touch. Identity, credentials and the signing keys belong to the auth server; this
document treats that service as the trust anchor and analyses what the IRC server
does with the tokens it issues.

Code references: `src/ws/attach.ts` (upgrade auth, limits, backpressure),
`src/infrastructure/auth/verify-token.ts` (token verification),
`src/modules/routing/index.ts` (routing and filters),
`src/runtime/{dedupe,presence,rate-limit}.ts`, `deploy/Caddyfile`.

---

## 1. Assets and trust boundaries

| Asset | Where it lives | Impact if compromised |
| --- | --- | --- |
| Mojang identity (UUID) bound to a socket | JWT claim | impersonation of a player in groups/DIRECT messages |
| Access token | client; never logged | full IRC access until expiry/revocation |
| Group membership and roles | MongoDB `irc_group_members` | unauthorised group messaging, filter edits |
| Filter rules | MongoDB `irc_filter_rules` | message suppression or unwanted delivery |
| Audit trail | MongoDB `irc_audit_logs` | loss of forensic evidence |
| Presence state | Redis | privacy leak (who is online), wrong routing |
| Session revocation fast path | Redis `auth:session:revoked:*` | a banned session stays valid |

Trust boundaries:

```
client (untrusted) ── TLS/WSS ──▶ Caddy (edge) ── internal net ──▶ irc-server ──▶ mongo / redis
                                                                        │
                                                                        └──▶ JWKS ──▶ auth-server (trust anchor)
```

Nothing from the client is trusted except: it holds a token (verified), it can
send frames (size/rate limited), and its socket address (used only for per-IP
limits behind a trusted proxy). **Every identity decision is derived from the
verified token or MongoDB, never from a frame, path, query or header.**

---

## 2. Attacker model

1. **Unauthenticated internet client** — can only reach the IRC edge through
   Caddy, cannot produce a valid token.
2. **Authenticated but unprivileged player** — has a valid
   `skymatrix:ircserver` token; may attempt to spoof identity, abuse fan-out,
   enumerate groups, or exhaust resources.
3. **Privileged insider** — an `ADMIN_UUIDS` identity or a token holding
   `skymatrix:irc:broadcast`.
4. **Compromised dependency** — Redis or MongoDB unavailable or tampered with.
5. **Network attacker** — can drop/inject traffic on the internal Docker network
   (assumed partially hostile; the app itself never listens on the host).

Out of scope: compromise of the auth server's signing key (see §7), and
compromise of the host running Docker.

---

## 3. Threats and mitigations

### T1 — Forged identity inside a frame

**Attack:** a player sends `MESSAGE` with `payload.sender`, `sender`, or a `route`
that claims to be someone else, or sends a DIRECT message on behalf of another
player.

**Mitigation:**
- The delivered frame's `sender` is written by the server from the connection's
  verified identity (`DeliverableMessage.sender`), and the client schema has no
  `sender` field — extra keys are dropped by `clientFrameSchema`.
- `route.target` is only a *destination*; it can never set the sender.
- The recipient sees `sender.minecraftUuid` from the JWT, never from the payload.

**Residual risk:** none known for identity. A client can still lie *inside* the
payload (e.g. `{"text":"I am an admin"}`) — that is application-level trust, which
no relay can fix; clients must attribute content to `sender`, not to payload text.

### T2 — Scope-less token

**Attack:** a token issued for another Skymatrix service (e.g. only
`skymatrix:profile`) is replayed against the IRC endpoint.

**Mitigation:** `verifyAccessToken` requires `skymatrix:ircserver` in the
space-separated `scope` claim and answers `403 SCOPE_DENIED` at the upgrade,
before a socket exists. The same check protects every REST route because
`requireAuth` uses the identical function.

**Residual risk:** none known; the scope list is controlled by the auth server.

### T3 — Replay and stolen tokens

**Attack (a):** re-send a captured JWT. **Attack (b):** re-send a captured
*message frame* (same `id`).

**Mitigation:**
- (a) Tokens are bearer credentials by design. Blast radius is bounded by a
  15-minute access-token TTL (auth server `ACCESS_TOKEN_TTL_SECONDS=900`), a
  per-user connection cap (`MAX_CONNECTIONS_PER_USER=3`), and immediate
  revocation via the shared Redis key checked on every upgrade.
- (b) `DedupeStore` keys on `(senderUserId, messageId)` in Redis with
  `SET NX PX DEDUPE_TTL_MS`; an identical payload inside the window gets
  `ACK accepted` and is **not** re-delivered, a different payload gets
  `DUPLICATE_MESSAGE_ID`.

**Residual risk:** a stolen token is usable until it expires or its session is
revoked, and the dedupe window is 120 s — a deliberate re-send after the window
is indistinguishable from a new message. Token theft prevention (device binding,
DPoP-style proof) is out of scope for v1.

### T4 — Cache staleness after kick/ban/revocation

This is the one area where the design intentionally trades freshness for
throughput, and the trade-offs differ per feature:

| Change | Propagates | Staleness |
| --- | --- | --- |
| **Session revoked** (logout, ban, refresh-token reuse) | Redis key read on every **upgrade** | **Existing sockets are not closed.** A banned player keeps their live socket until it closes or the token expires. |
| **Filter rule change** | local write invalidates that process's cache; entries otherwise live `CACHE_TTL_MS = 5s` | On a multi-node deployment another node can use the old rule set for up to 5 s. Single node: immediate. |
| **Group member removed/kicked** | membership is read per GROUP message from MongoDB (no cache) | Immediate: the next message is not delivered. |
| **Group role change** | read per REST request | Immediate. |
| **Presence visibility** | membership checked per request | Immediate. |
| **`ADMIN_UUIDS` change** | config read at boot | Requires a restart. |

**Residual risk (accepted for v1):** revocation does not terminate open sockets,
and a filter change can be honoured up to 5 s late across nodes. Operational
mitigation: a ban is enforced at the next reconnect; to force a disconnect now,
restart or scale the affected node (all sockets close with 1001). A future phase
can subscribe to a revocation channel and close matching sockets.

### T5 — Connection flooding / capacity exhaustion

**Attack:** open as many WebSockets as possible to exhaust file descriptors or
memory.

**Mitigation:**
- `MAX_CONNECTIONS_PER_USER = 3` (429 at upgrade),
- `MAX_CONNECTIONS_PER_IP = 20` (429 at upgrade, using the trusted
  `X-Forwarded-For` hop),
- `MAX_CONNECTIONS_TOTAL = 10 000` (503 at upgrade),
- capacity is checked **before** `wss.handleUpgrade`, so a rejected client never
  allocates a WebSocket,
- unauthenticated clients cannot allocate anything beyond one HTTP request.

**Residual risk:** the per-IP cap is only as good as the client IP the edge
supplies. If the service is exposed without Caddy (or with a proxy that appends
rather than replaces `X-Forwarded-For`), an attacker can rotate the header. The
compose stack keeps the app internal-only and Caddy replaces the header
(`header_up X-Forwarded-For {remote_host}`), which is why `trustProxy` is safe
there. **Never publish port 3001.**

### T6 — Slow client / backpressure

**Attack:** read nothing after connecting, forcing the server to buffer fan-out
for that socket until memory is exhausted.

**Mitigation:**
- Before every send: `socket.bufferedAmount > MAX_WS_BUFFERED_BYTES (1 MiB)` →
  close with `1013 backpressure` and log the event, so one stuck client cannot
  consume another's memory.
- RFC 6455 ping every 30 s, terminated when no pong within 15 s: a dead or
  frozen TCP connection is reaped instead of lingering.
- Per-connection rate limit bounds how fast a client can make the server fan out.

**Residual risk:** the budget is per socket, so 10 000 sockets × 1 MiB is still
a lot of theoretical memory; the total connection cap and per-IP cap are the
practical bound.

### T7 — Fan-out abuse (amplification)

**Attack:** a player sends BROADCAST messages (or GROUP messages to a large
group) repeatedly to amplify work by a factor of the online population.

**Mitigation:**
- BROADCAST requires `BROADCAST_ENABLED=true` **and** the
  `skymatrix:irc:broadcast` scope or an `ADMIN_UUIDS` identity; every broadcast
  is audited (`irc.broadcast.sent` with recipient count).
- GROUP messages use a stricter bucket (`GROUP_MESSAGE_RATE_PER_SEC = 10`,
  burst = 2×), and group size is capped (`MAX_GROUP_MEMBERS = 100`).
- DIRECT/BROADCAST share the 20/s + burst 40 bucket per connection.
- Group **creation** is quota-limited per player per clock hour
  (`CREATE_GROUP_PER_HOUR`, Redis fixed window). This is an anti-abuse limit, not
  a security gate: it **fails open** if Redis is unavailable, so a Redis outage
  must not be relied on to stop group creation.
- Every fan-out path re-checks per-recipient deny rules and `isOpen` before
  enqueueing, and a throwing socket never aborts the loop.

**Residual risk:** one token costs one rate-limit token but can reach 10 000
sockets. A compromised broadcast-capable identity can saturate a node's egress
for as long as the bucket allows; there is no per-recipient delivery budget. The
kill switches are `BROADCAST_ENABLED=false` and revoking the scope/session.

### T8 — Envelope fuzzing / parser abuse

**Attack:** malformed JSON, deeply nested payloads, oversized frames, wrong
versions, unknown ops.

**Mitigation:**
- `ws` enforces `maxPayload = MAX_FRAME_BYTES (128 KiB)` and closes with 1009
  before the application sees the frame; a second size check exists in code.
- JSON parse failures → `ERROR INVALID_ENVELOPE`; schema failures →
  `INVALID_ENVELOPE`/`UNSUPPORTED_VERSION`; the connection stays open.
- `type` is validated by a fixed regex + reserved-prefix list; it is never
  interpreted beyond routing and filter matching.
- Filter patterns are a closed grammar (exact / trailing `*` / `*`), so a rule
  cannot become a regex bomb.

**Residual risk:** JSON parsing is proportional to frame size; 128 KiB × rate
limit is the CPU ceiling per socket.

### T9 — Filter bypass / denial of service via rules

**Attack:** a player tries to receive message types they denied, or to deny
others' traffic.

**Mitigation:**
- GLOBAL rules are editable only by an `ADMIN_UUIDS` identity.
- GROUP rules are editable only by that group's OWNER/ADMIN.
- USER rules are private to their owner (`/v1/filters/me`); there is no endpoint
  to read or write another player's user rules.
- Evaluation is deny-first and `enabled`-only; the global deny applies before
  routing to all three modes.

**Residual risk:** filters only decide *types*; a member who accepts `chat.*`
receives all chat. Content moderation is out of scope, and because messages are
never stored there is no retrospective content review.

### T10 — Group / presence enumeration

**Attack:** probe for the existence of private groups or the online status of
arbitrary players.

**Mitigation:**
- `GET /v1/groups/:id` returns `GROUP_NOT_FOUND` for a non-member, identical to a
  nonexistent group.
- GROUP message routing returns `GROUP_ACCESS_DENIED` for both "not a member" and
  "does not exist".
- Presence of another player is visible only to group co-members or an
  administrator; there is no listing endpoint.

**Residual risk:** a member can enumerate the groups they belong to and their
co-members by design.

### T11 — Redis outage

**Attack/failure:** Redis becomes unavailable (outage, OOM, network partition).

**Behaviour:**
- **Upgrade:** `verifyAccessToken` fails closed — it cannot prove the session is
  not revoked, so it answers `401 UNAUTHORIZED`. New connections are refused
  rather than accepted unverified. **This is deliberate.**
- **Presence:** writes are best-effort (`.catch(() => {})`), so a Redis outage
  degrades presence but does not refuse connections that are already open.
- **Dedupe:** `DedupeStore.begin` needs Redis; with Redis down the send path
  throws, the socket handler catches it and answers the sender with
  `ERROR INTERNAL_ERROR` + `ACK failed INTERNAL_ERROR` (the connection stays
  open). Nothing is delivered, and the client can retry when Redis is back.

**Residual risk:** a Redis failure makes the service fail closed for new
connections (secure but unavailable), and the message path has no local fallback
for dedupe — messages are refused rather than risk a double delivery. A failed
Redis round-trip costs one error frame per message, not a crash: the handler is
wrapped in `try/catch` and logs with the connection id. Operationally: Redis is a
hard dependency for accepting new connections; size it and monitor it like one.

### T12 — MongoDB outage

**Behaviour:** `/health/ready` returns 503 (`checks.mongo = "fail"`) so the
orchestrator stops sending upgrades, but a socket that is already open keeps
working for DIRECT messages (routing does not need MongoDB) while GROUP routing,
filters-disabled paths and all REST writes fail (`GROUP_NOT_FOUND`, 500).

**Residual risk:** partial availability looks like "group messages silently stop
working" to players. The readiness probe is the operational signal.

### T13 — `X-Forwarded-For` spoofing

**Attack:** rotate `X-Forwarded-For` to defeat per-IP limits or poison audit IPs.

**Mitigation:** the server trusts the header (`trustProxy: true`) and uses the
**last** hop, which is the value the trusted edge writes. Caddy *replaces* the
header (`header_up X-Forwarded-For {remote_host}`), so a client-supplied chain is
discarded. The service itself publishes no host port.

**Residual risk:** any process on the internal Docker network can spoof the
header. Keep the network internal and treat other containers as trusted.

### T14 — Log leakage (tokens, payloads)

**Attack:** secrets or message content leaking into logs.

**Mitigation:**
- Fastify is configured with `redact: ['req.headers.authorization', 'req.headers.cookie']`.
- The Caddy access log redacts `Authorization`/`Cookie` to `REDACTED` by default
  (verified against `caddy:2-alpine`).
- Audit records carry identifiers and counters, never payloads; `metadata` is
  sanitised on write.
- The application never logs frames or tokens; the WS layer logs connection ids
  and buffered byte counts only.

**Residual risk:** query strings are recorded by the edge access log. SRP never
accepts a token in a URL (header only), and the only query parameters are
non-secret list filters — keep it that way.

### T15 — TLS and transport downgrade

**Attack:** force a plaintext connection or MITM the WebSocket.

**Mitigation:** Caddy terminates TLS with automatic certificates, HSTS
(`max-age=31536000; includeSubDomains; preload`), and only 80/443 are published;
port 80 redirects to HTTPS. The service has no plaintext public listener.

**Residual risk:** `ws://` is still possible on loopback for development; never
expose it.

### T16 — Privileged identity compromise

**Attack:** an `ADMIN_UUIDS` identity or a broadcast-scoped token is abused.

**Mitigation:** global filter edits and broadcasts are audited with the actor's
UUID and IP; `BROADCAST_ENABLED` is a global kill switch; admin identities are
configuration, not self-service grants.

**Residual risk:** an admin can suppress message types globally (denial of
service for those types). Audit records make it reviewable, not preventable.

---

## 4. Residual risk summary

| # | Residual risk | Severity | Mitigation available today |
| --- | --- | --- | --- |
| 1 | Revoked/ banned session keeps an **open** socket | High | revoke + force reconnect (restart/scale); short token TTL |
| 2 | Broadcast amplification by a compromised broadcast scope | Medium | `BROADCAST_ENABLED=false`, revoke scope/session, audit review |
| 3 | Redis outage refuses new connections (fail closed); messages are refused with `INTERNAL_ERROR` while Redis is down | Medium | monitor Redis; the handler degrades instead of crashing |
| 4 | 5 s filter-cache staleness across nodes | Low | single node; or restart after rule changes |
| 5 | No content retention ⇒ no abuse review | Medium (product decision) | application-level reporting outside IRC |
| 6 | Per-IP limits depend on the trusted edge | Low | keep the service internal-only |
| 7 | Bearer tokens are usable by whoever holds them | Medium | 15-min TTL, revocation, per-user connection cap |

---

## 5. Controls checklist for an operator

- [ ] `irc-server` publishes **no** host port; only Caddy is exposed (verified in
      `deploy/compose.yaml`).
- [ ] `MONGODB_URI`/`REDIS_URL` use the internal service names and passwords from
      `deploy/.env`, never defaults.
- [ ] `ADMIN_UUIDS` is an explicit allow-list; `BROADCAST_ENABLED` reflects policy.
- [ ] Redis and MongoDB credentials are distinct from application secrets and are
      rotated together with `deploy/.env`.
- [ ] MongoDB indexes are present (they are created at boot when
      `MONGODB_ENSURE_INDEXES=true`; check the first-boot log and confirm the
      audit-log TTL index exists) — see
      [irc-database.md §4.1](./irc-database.md#41-how-the-indexes-are-created).
- [ ] Log shipping includes `/data/irc-access.log` and the container logs; verify
      that `Authorization` appears as `REDACTED`.
- [ ] Monitoring reads `/health/ready` (503 ⇒ remove from rotation) and watches
      `connections` on `/metrics` with an admin token.

---

## 6. What the server deliberately does not do

- No message storage, no delivery receipts, no "read" state — `delivered` means
  "handed to the socket", nothing more ([srp-v1.md §5](./srp-v1.md#5-ack-semantics--delivered-is-not-processed)).
- No end-to-end encryption: TLS to the edge, plaintext inside the trusted Docker
  network. A compromised host sees message content.
- No IP allow-listing, no device binding, no proof-of-possession on tokens.
- No content moderation beyond type-level filters.

---

## 7. Trust anchor: the auth server

The IRC server accepts exactly what the auth server signs:

- Ed25519 signature verified against `AUTH_JWKS_URL` (cached by `jose` for up to
  10 minutes, with a 5 s cooldown for unknown `kid`);
- `iss`/`aud` pinned by configuration, `exp` enforced;
- session revocation read from the same Redis instance the auth server writes.

Consequences:

- A stolen auth-server signing key compromises the IRC server completely; key
  rotation must be coordinated (new `kid` is picked up automatically, old tokens
  remain valid until they expire).
- If the auth server's JWKS is unreachable at the moment a token is verified, the
  upgrade fails with `401 UNAUTHORIZED` (fail closed). Long JWKS cache lifetimes
  reduce that exposure but delay key rotation.
- `JWT_ISSUER`/`JWT_AUDIENCE` must match the auth server exactly; a mismatch turns
  every token into `UNAUTHORIZED` (availability, not a security hole).

---

## 8. Known gaps in v1 (verified against the code)

These are documented rather than silently assumed safe:

1. **Revocation does not close open sockets** (see T4). This is the one to fix
   before a public launch: a banned player keeps their live socket until it
   closes on its own.
2. **REST rate limiting is partial**: only group creation is limited
   (`CREATE_GROUP_PER_HOUR`, and that limiter fails open if Redis is down); the
   other REST endpoints remain unlimited.
3. **No CORS middleware** (`CORS_ORIGINS` is parsed but unused). The API is
   server-to-server / mod-client only.
4. **No message retention** — an intentional privacy property, but it also means
   there is no content to review after an abuse report.

Dependency failures no longer crash the socket handler: `handleMessageFrame` is
wrapped in `try/catch` and answers `ERROR INTERNAL_ERROR` + `ACK failed
INTERNAL_ERROR`, and the payload budget is enforced before routing, so oversized
payloads are refused with `PAYLOAD_TOO_LARGE` instead of being fanned out.
