# SRP v1 — SkyMatrix Relay Protocol

The wire contract between a Minecraft client (or any SDK) and the SkyMatrix IRC
server. Everything here is implemented by `packages/srp-protocol/src/index.ts`
(shapes, codes, limits) and `apps/irc-server/src/{ws/attach.ts,modules/routing/index.ts}`
(runtime behaviour). Where the implementation is narrower than the original
design, this document says so explicitly.

Related documents:

- [irc-api.md](./irc-api.md) — the REST surface (groups, filters, presence, health)
- [irc-security.md](./irc-security.md) — threat model and mitigations
- [irc-deployment.md](./irc-deployment.md) — compose, Caddy, scaling, shutdown
- [irc-database.md](./irc-database.md) — MongoDB collections and indexes
- [irc-contract.md](./irc-contract.md) — build contract for the implementation

---

## 1. Transport

| | |
| --- | --- |
| Endpoint | `GET /v1/connect` |
| Scheme | `wss://` in production (TLS terminated by Caddy), `ws://` on loopback in development |
| Authentication | `Authorization: Bearer <access token>` on the **upgrade request** |
| Token | The auth server's Ed25519 access JWT; must contain `skymatrix:ircserver` in `scope` |
| Payloads | UTF-8 JSON text frames; one frame = one JSON object |
| Compression | None at the protocol layer (`permessage-deflate` is not negotiated) |

Authentication happens *before* a socket exists. The server answers the HTTP
upgrade directly, synchronously, with a JSON error body:

| Condition | Status | `error.code` |
| --- | --- | --- |
| no `Authorization` header / not `Bearer` | `401` | `UNAUTHORIZED` |
| malformed, forged or foreign-signature token | `401` | `UNAUTHORIZED` |
| expired token | `401` | `TOKEN_EXPIRED` |
| token lacks `skymatrix:ircserver` | `403` | `SCOPE_DENIED` |
| session revoked (`auth:session:revoked:{sid}` in Redis) | `403` | `SESSION_REVOKED` |
| revocation check impossible (Redis down) | `401` | `UNAUTHORIZED` (fail closed) |
| server at per-user or per-IP connection cap | `429` | `RATE_LIMITED` |
| server at total connection cap | `503` | `RATE_LIMITED` |
| upgrade against any other path | `404` | `NOT_FOUND` |

Example rejection body:

```json
{ "error": { "code": "SCOPE_DENIED", "message": "Missing scope skymatrix:ircserver" } }
```

The token's claims are the only identity the server trusts: `sub` (internal user
id), `minecraft_uuid` (Mojang UUID, canonicalised to lowercase dashed),
`sid` (session id), `scope` (space-separated). Nothing a client puts in a frame
can change who it is.

---

## 2. Envelope

Every frame — in both directions — is a JSON object with at least `v`, `id` and `op`.

```jsonc
{ "v": 1, "id": "<string>", "op": "<OPERATION>", "...": "operation fields" }
```

| Field | Type | Rules |
| --- | --- | --- |
| `v` | integer | Must be exactly `1`. Any other value → `ERROR UNSUPPORTED_VERSION`. |
| `id` | string | 1–64 chars, chosen by the sender. Server frames use `srv_…` / `ack_…` ids. A client `id` must be unique per sender within the dedupe window (see §6). |
| `op` | string | One of the operations in §3. Unknown `op` → `ERROR INVALID_ENVELOPE`. |

### Operations

| Op | Direction | Purpose |
| --- | --- | --- |
| `READY` | server → client | First frame after a successful upgrade. |
| `MESSAGE` | both | Business message (client sends it; server delivers server-attested copies). |
| `ACK` | server → client | Outcome of a client `MESSAGE`, keyed by `replyTo`. |
| `ERROR` | server → client | A frame-level or protocol-level failure. |
| `PING` | client → server | Application-level keepalive. |
| `PONG` | server → client | Reply to `PING`. |
| `PRESENCE` | — | **Reserved in v1, never emitted.** Presence is queried over REST instead. |
| `GROUP_EVENT` | — | **Reserved in v1, never emitted.** Group changes are made and observed over REST. |

`PRESENCE` and `GROUP_EVENT` exist in `@skymatrix/srp-protocol` as `ServerFrame`
variants so a future version can add push semantics without a breaking change.
A client must ignore unknown ops rather than treat them as fatal.

---

## 3. Frame reference

### 3.1 `READY` (server → client)

Sent immediately after the upgrade is accepted, before any client frame is read.

```json
{
  "v": 1,
  "id": "srv_lq3k1f9a2b7c",
  "op": "READY",
  "type": "protocol.ready",
  "payload": {
    "connectionId": "0f1d8f0e-6a1c-4b0f-9a54-6a4c1b1e6f11",
    "userId": "6708a1c3c2f4a41e9c2f0b77",
    "minecraftUuid": "069a79f4-44e9-4726-a5be-fca90e38aaf5",
    "instanceId": "irc-01",
    "heartbeatIntervalMs": 30000,
    "serverTime": 1793978000000
  }
}
```

- `connectionId` identifies this socket (useful for support and for the presence
  records the server keeps in Redis).
- `minecraftUuid` is the identity used by groups/filters — always lowercase dashed.
- `serverTime` is the server's clock, the authority for TTL (§7).

### 3.2 `MESSAGE` (client → server)

```json
{
  "v": 1,
  "id": "0193060e-7a1f-7c3a-9d1e-2f6d1c0b9a11",
  "op": "MESSAGE",
  "type": "chat.message",
  "route": { "mode": "DIRECT", "target": "069a79f4-44e9-4726-a5be-fca90e38aaf5" },
  "payload": { "text": "hi" },
  "ttlMs": 10000,
  "replyTo": null
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `type` | yes | 1–128 chars, `[A-Za-z0-9._-]`, not `protocol.*`/`srp.*`, no leading dot, no empty segment. Validated by `validateTypeName`. |
| `route.mode` | yes | `DIRECT`, `GROUP` or `BROADCAST`. |
| `route.target` | yes | `DIRECT`: the recipient's Minecraft UUID (dashed or undashed, normalised server-side). `GROUP`: a group id (`grp_…`). `BROADCAST`: `null`. |
| `payload` | yes | Any JSON value (object, array, string, number, `null`). The server never interprets it. |
| `ttlMs` | no | Integer 1000–60000. Defaults to 10000. Out-of-range fails schema validation → `INVALID_ENVELOPE`. |
| `replyTo` | no | Another message id this one replies to. Echoed to recipients; not validated against history. |

### 3.3 `MESSAGE` (server → recipient)

The delivered frame is the client frame plus server-attested fields. A client may
not set `sender`, `receivedAt` or `expireAt`; if it tries, the extra keys are
ignored by the schema and overwritten by the server's values.

```json
{
  "v": 1,
  "id": "0193060e-7a1f-7c3a-9d1e-2f6d1c0b9a11",
  "op": "MESSAGE",
  "type": "chat.message",
  "route": { "mode": "DIRECT", "target": "069a79f4-44e9-4726-a5be-fca90e38aaf5" },
  "payload": { "text": "hi" },
  "ttlMs": 10000,
  "replyTo": null,
  "sender": {
    "userId": "6708a1c3c2f4a41e9c2f0b77",
    "minecraftUuid": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"
  },
  "receivedAt": 1793978000123,
  "expireAt": 1793978010123
}
```

`ttlMs` on the delivered frame is recomputed as `expireAt - receivedAt`, so it is
always the effective TTL the server applied.

### 3.4 `ACK` (server → client)

```json
{ "v": 1, "id": "srv_…", "op": "ACK", "type": "protocol.ack",
  "replyTo": "0193060e-7a1f-7c3a-9d1e-2f6d1c0b9a11",
  "payload": { "status": "delivered", "recipients": 1 } }
```

| `payload.status` | Meaning |
| --- | --- |
| `accepted` | The frame passed validation, filters, dedupe and TTL checks and is being routed. |
| `delivered` | Fan-out enqueued at least one recipient socket (`recipients` > 0), or a GROUP/BROADCAST fan-out completed (a GROUP message to a group with nobody else online reports `delivered` with `recipients: 0`). |
| `failed` | Nothing was delivered; `payload.reason` carries the `SrpErrorCode`. |

`recipients` counts **sockets**, not players: a player connected from two devices
counts twice.

### 3.5 `ERROR` (server → client)

```json
{ "v": 1, "id": "srv_…", "op": "ERROR", "type": "protocol.error",
  "replyTo": "0193060e-…",
  "payload": { "code": "INVALID_TYPE", "message": "type uses the reserved prefix srp." } }
```

`replyTo` is the offending client frame id when the server could attribute the
error, otherwise `null`.

### 3.6 `PING` / `PONG`

```json
{ "v": 1, "id": "0193060e-…", "op": "PING" }
{ "v": 1, "id": "srv_…", "op": "PONG", "type": "protocol.pong", "replyTo": "0193060e-…" }
```

`PING` is answered synchronously and does not consume rate-limit budget. The
primary liveness mechanism is RFC 6455 ping/pong: the server pings every
`heartbeatIntervalMs` (30 s) and terminates the socket if no pong arrives within
`pongTimeoutMs` (15 s).

---

## 4. Routing

### DIRECT

1. `route.target` must parse as a UUID (dashed or 32-hex), otherwise
   `ERROR INVALID_ENVELOPE`.
2. If no local connection belongs to that UUID → `ACK failed { reason: "TARGET_OFFLINE" }`.
   The same reason is used when a socket disappears between lookup and send.
3. The recipient's own filter rules are evaluated (see §8) → `ACK failed { reason: "TYPE_DENIED" }`.
4. Every live socket of the recipient is enqueued → `ACK delivered { recipients: n }`.

A player may address themselves; the message is then delivered to their own sockets.

### GROUP

1. `route.target` must be a group id, otherwise `ERROR INVALID_ENVELOPE`.
2. The sender must be a member. A non-member and a nonexistent group are
   deliberately indistinguishable: both produce `ACK failed { reason: "GROUP_ACCESS_DENIED" }`.
   A storage-level failure produces `GROUP_NOT_FOUND`.
3. The group's filter rules are evaluated → `TYPE_DENIED`.
4. The message is delivered to the online sockets of every **other** member.
   Per-recipient rules remove individual members. `ACK delivered { recipients: n }`
   is always returned, even when `n === 0` (a group message is not an error when
   nobody else is online).
5. Group messages draw from a stricter token bucket (§9).

### BROADCAST

1. Requires `BROADCAST_ENABLED=true` **and** either the `skymatrix:irc:broadcast`
   scope on the token or the sender's UUID in `ADMIN_UUIDS`; otherwise
   `ACK failed { reason: "BROADCAST_DENIED" }`.
2. Global and per-recipient filters apply.
3. The frame is delivered to **every** local connection, including the sender's own
   sockets (v1 semantics: "all eligible connections"), and an audit entry
   `irc.broadcast.sent` is recorded.
4. `ACK delivered { recipients: n }`.

### Fan-out scope

Fan-out is local to the node that owns the sockets. `PRESENCE` records in Redis
are shared across nodes, but message routing across nodes (Redis pub/sub) is not
part of v1 — see [irc-deployment.md](./irc-deployment.md#scaling-out).

---

## 5. ACK semantics — `delivered` is not `processed`

This is the most important rule in the protocol:

- `accepted` means **the server took responsibility for routing** the frame.
- `delivered` means **the server handed the frame to the recipient's socket**
  (enqueued in the TCP/WebSocket buffer).
- Neither status means the recipient's application *read*, *displayed*, or
  *acted on* the message. There is no read receipt in v1, and the server never
  claims one.

A normal DIRECT message to an online player produces **two** ACK frames:

```
client ── MESSAGE ──▶ server
client ◀── ACK {status:"accepted"}   (validation/filter/dedupe/TTL passed)
client ◀── ACK {status:"delivered", recipients:1}   (fan-out enqueued)
```

Failure paths produce `accepted` followed by `failed`, or a single `ERROR` when
the frame never became a routable message:

| Situation | Frames sent to the sender |
| --- | --- |
| invalid type / reserved namespace | `ERROR INVALID_TYPE` (no ACK) |
| invalid JSON / schema violation / bad DIRECT target | `ERROR INVALID_ENVELOPE` (no ACK) |
| `v` ≠ 1 | `ERROR UNSUPPORTED_VERSION` (no ACK) |
| globally denied type | `ACK failed TYPE_DENIED` (no `accepted` first) |
| identical duplicate of an already-accepted id | `ACK accepted` only |
| same id, different payload | `ACK failed DUPLICATE_MESSAGE_ID` |
| business payload over `MAX_PAYLOAD_BYTES` | `ERROR PAYLOAD_TOO_LARGE` **and** `ACK failed PAYLOAD_TOO_LARGE` |
| rate limit exceeded | `ERROR RATE_LIMITED` **and** `ACK failed RATE_LIMITED` |
| unexpected internal failure (dependency error) | `ERROR INTERNAL_ERROR` **and** `ACK failed INTERNAL_ERROR` |
| DIRECT target offline | `ACK accepted`, `ACK failed TARGET_OFFLINE` |
| GROUP: not a member | `ACK accepted`, `ACK failed GROUP_ACCESS_DENIED` |
| GROUP: nobody else online | `ACK accepted`, `ACK delivered {recipients:0}` |
| BROADCAST not authorised | `ACK accepted`, `ACK failed BROADCAST_DENIED` |
| message aged past `expireAt` before fan-out | `ACK accepted`, `ACK failed MESSAGE_EXPIRED` |

Clients should key on `replyTo` and tolerate frames arriving in any order
relative to other messages.

---

## 6. Dedupe and replay suppression

Message ids are client-generated, so a flaky connection can resend the same
message. The server keeps a short-lived record per `(sender, message id)`:

```
key    irc:dedupe:{senderUserId}:{messageId}
value  { "fingerprint": "<sha256(payload ?? null)[:32]>", "at": <ms> }
TTL    DEDUPE_TTL_MS (default 120000 ms)
```

Behaviour:

| Incoming frame | Result |
| --- | --- |
| first time | routed normally; `ACK accepted` → `delivered`/`failed` |
| same id **and** identical payload | `ACK accepted` only; **not** re-delivered |
| same id **and** different payload | `ACK failed DUPLICATE_MESSAGE_ID`; not delivered |

Notes:

- The key includes the sender's internal user id, so two players can never
  collide on an id — a replayed id from another account is a different key.
- The window is `DEDUPE_TTL_MS`, **not** the message TTL. A message id can be
  reused after the window closes.
- Dedupe happens after the type-name check and after the global filter, so a
  globally denied type is rejected without occupying a dedupe key.

---

## 7. TTL and expiry

- `expireAt = receivedAt + ttlMs`, both on the **server's** clock
  (`computeExpireAt` in `@skymatrix/srp-protocol`).
- `ttlMs` defaults to 10 000 ms, minimum 1 000 ms, maximum 60 000 ms. Values
  outside the range fail schema validation (`INVALID_ENVELOPE`).
- Recipients receive `receivedAt`, `expireAt` and the effective `ttlMs` so they
  can drop a stale frame instead of showing a late message.
- The server also enforces expiry at fan-out time: if `now > expireAt` when
  routing starts, the sender gets `ACK failed { reason: "MESSAGE_EXPIRED" }` and
  nothing is delivered (DIRECT, GROUP and BROADCAST).
  In a single-node v1 deployment this guard is not reachable from the outside —
  validation and fan-out happen in the same tick and the minimum TTL is one
  second — but it is the contract that cross-node forwarding (Phase 3) relies on.

---

## 8. Type names and filter patterns

### Type names

`validateTypeName` accepts `^[A-Za-z0-9._-]+$`, 1–128 characters, and rejects:

- empty strings;
- `protocol.` and `srp.` prefixes (reserved for the protocol itself);
- a leading `.` and any `..` segment.

Anything else → `ERROR INVALID_TYPE` with a human-readable reason.

### Filter patterns

Filter rules (see [irc-api.md](./irc-api.md#filters)) use a deliberately
trivial grammar, so a hostile rule can never burn CPU:

| Pattern | Matches |
| --- | --- |
| `chat.message` | exactly that type |
| `chat.*` | `chat` itself and anything under `chat.` |
| `*` | everything |

Only a trailing `*` is supported; no regex, no character classes, no mid-string
wildcards. `ALLOW`/`DENY` rules are evaluated per scope:

| Scope | Applied to |
| --- | --- |
| `GLOBAL` | every message, before routing (admin-managed) |
| `GROUP` | messages routed to that group |
| `USER` | messages addressed **to** that user (DIRECT), and their membership of GROUP/BROADCAST fan-out |

`DENY` wins over `ALLOW` for the same type. Messages have no per-message
authorisation beyond this: the server routes what the filters allow.

---

## 9. Limits

Protocol limits (`@skymatrix/srp-protocol` → `LIMITS`):

| Limit | Value |
| --- | --- |
| `maxTypeLength` | 128 |
| `maxPayloadBytes` | 65 536 (64 KiB) — the advertised business-payload budget |
| `maxFrameBytes` | 131 072 (128 KiB) — the whole WebSocket frame |
| `maxMessageIdLength` | 64 |
| `defaultTtlMs` / `minTtlMs` / `maxTtlMs` | 10 000 / 1 000 / 60 000 |
| reserved prefixes | `protocol.`, `srp.` |

Server-side limits (env-configurable, defaults in `apps/irc-server/src/config/env.ts`):

| Setting | Default | Effect |
| --- | --- | --- |
| `MAX_FRAME_BYTES` | 131 072 | `ws` `maxPayload`; a larger frame closes the socket (1009) before any parsing |
| `MAX_PAYLOAD_BYTES` | 65 536 | Configured budget for business payloads |
| `MAX_CONNECTIONS_PER_USER` | 3 | Concurrent sockets per Mojang UUID (429 at upgrade) |
| `MAX_CONNECTIONS_PER_IP` | 20 | Concurrent sockets per client IP (429 at upgrade) |
| `MAX_CONNECTIONS_TOTAL` | 10 000 | Concurrent sockets per node (503 at upgrade) |
| `MESSAGE_RATE_PER_SEC` / `MESSAGE_BURST` | 20 / 40 | Token bucket for DIRECT/BROADCAST frames, per connection |
| `GROUP_MESSAGE_RATE_PER_SEC` | 10 | Token bucket for GROUP frames, per connection; burst is 2× the rate |
| `MAX_GROUP_MEMBERS` | 100 | Members per group |
| `MAX_WS_BUFFERED_BYTES` | 1 048 576 | A socket whose send buffer exceeds this is closed (`1013 backpressure`) |
| `DEDUPE_TTL_MS` | 120 000 | Replay-suppression window |
| `HEARTBEAT_INTERVAL_MS` / `PONG_TIMEOUT_MS` | 30 000 / 15 000 | RFC 6455 liveness |
| `PRESENCE_TTL_MS` | 90 000 | Redis presence record TTL |

Implementation notes (verified against the code, not the design):

- The whole-frame limit is enforced by `ws` (`maxPayload`): a larger frame closes
  the socket with 1009 before any parsing.
- The business payload budget (`MAX_PAYLOAD_BYTES`, 64 KiB) is enforced
  separately and **before** routing: the payload is serialised and measured in
  UTF-8 bytes, and an oversized payload gets `ERROR PAYLOAD_TOO_LARGE` plus
  `ACK failed { reason: "PAYLOAD_TOO_LARGE" }` while the connection stays open.
- `CREATE_GROUP_PER_HOUR` is enforced at the **REST** boundary (per-user hourly
  quota on `POST /v1/groups`, `429 RATE_LIMITED` + `retry-after`); it does not
  affect WebSocket routing. See [irc-api.md §5](./irc-api.md#post-v1groups).
- At most 100 filter rules are accepted per scope (`MAX_RULES_PER_SCOPE`).

---

## 10. Presence (what a client can rely on)

The server keeps cross-node presence in Redis, but v1 exposes it over REST, not
over the socket:

```
irc:presence:conn:{connectionId}    JSON record, TTL PRESENCE_TTL_MS
irc:presence:user:{minecraftUuid}   SET of connectionIds, same TTL
irc:presence:instance:{instanceId}  SET of connectionIds, same TTL
```

A user is online iff at least one of their connection records still exists. Set
membership alone is never treated as proof of life — a crashed node's leftovers
expire via TTL and are pruned by a sweeper.

`GET /v1/presence/me` returns the caller's own state; `GET /v1/presence/:uuid`
returns another player's state only when the caller shares a group with them (or
is an administrator UUID). There is deliberately no "list everyone online"
endpoint. See [irc-api.md](./irc-api.md#presence).

---

## 11. Error-code table

Codes are defined once in `@skymatrix/srp-protocol` (`SRP_ERROR_CODES`) and used
by both transports.

| Code | Delivered as | Meaning | Connection stays open? |
| --- | --- | --- | --- |
| `UNAUTHORIZED` | HTTP 401 at upgrade; REST 401 | Missing/invalid token, missing claims, or revocation state unknown (fail closed) | n/a (no socket) |
| `TOKEN_EXPIRED` | HTTP 401 at upgrade | `exp` in the past | n/a |
| `SCOPE_DENIED` | HTTP 403 at upgrade | Token lacks `skymatrix:ircserver` | n/a |
| `SESSION_REVOKED` | HTTP 403 at upgrade | `auth:session:revoked:{sid}` present in Redis | n/a (existing sockets are not cut) |
| `INVALID_ENVELOPE` | `ERROR` frame | Not JSON, schema violation, bad DIRECT/GROUP target | yes |
| `UNSUPPORTED_VERSION` | `ERROR` frame | `v` ≠ 1 | yes |
| `INVALID_TYPE` | `ERROR` frame | Type name rejected by `validateTypeName` | yes |
| `TYPE_DENIED` | `ACK failed` | Global, group or per-recipient filter denied the type | yes |
| `TARGET_OFFLINE` | `ACK failed` | No live local connection for the DIRECT target | yes |
| `GROUP_NOT_FOUND` | `ACK failed` | Storage-level group lookup failure | yes |
| `GROUP_ACCESS_DENIED` | `ACK failed` | Sender is not a member (or the group does not exist — indistinguishable) | yes |
| `BROADCAST_DENIED` | `ACK failed` | Broadcast disabled, or no scope/admin UUID | yes |
| `RATE_LIMITED` | `ERROR` + `ACK failed`; HTTP 429/503 at upgrade | Token bucket exhausted, or a connection cap hit | yes |
| `PAYLOAD_TOO_LARGE` | `ERROR` + `ACK failed` | Business payload over `MAX_PAYLOAD_BYTES`, measured before routing (an oversized *frame* is closed by `ws` with 1009 instead) | yes |
| `MESSAGE_EXPIRED` | `ACK failed` | `now > expireAt` when fan-out starts | yes |
| `DUPLICATE_MESSAGE_ID` | `ACK failed` | Same id, different payload, inside the dedupe window | yes |
| `INTERNAL_ERROR` | `ERROR` + `ACK failed` | Unexpected failure while handling a message (logged with the connection id; the client always gets an answer) | yes |

REST uses a separate, smaller code set (`UNAUTHORIZED`, `FORBIDDEN`,
`NOT_FOUND`, `INVALID_REQUEST`, `RATE_LIMITED`, `GROUP_NOT_FOUND`,
`GROUP_ACCESS_DENIED`, `CONFLICT`, `PAYLOAD_TOO_LARGE`, `INTERNAL`) documented in
[irc-api.md](./irc-api.md#error-envelope).

---

## 12. Versioning

- The version is a single integer carried in every frame (`v: 1`).
- Adding an operation, an optional field or a new error code does **not** bump
  `v`; clients must ignore unknown ops and unknown fields.
- Changing the meaning of an existing field, or removing one, requires `v: 2`.
  A v1 server rejects `v: 2` with `UNSUPPORTED_VERSION` rather than guessing.
- `PRESENCE` and `GROUP_EVENT` are reserved in v1 to avoid a breaking change when
  push semantics arrive.

---

## 13. Worked example

```text
1. client → GET /v1/connect  (Upgrade: websocket, Authorization: Bearer eyJ…)
2. server → 101 Switching Protocols
3. server → READY {connectionId, minecraftUuid, heartbeatIntervalMs: 30000, …}
4. client → MESSAGE {id:"m1", type:"chat.message", route:{mode:"DIRECT",
              target:"069a79f4-…"}, payload:{"text":"hi"}, ttlMs:10000}
5. server → ACK {replyTo:"m1", payload:{status:"accepted"}}
   server →  (recipient socket) MESSAGE {…, sender:{minecraftUuid:"a1b2…"}, receivedAt, expireAt}
6. server → ACK {replyTo:"m1", payload:{status:"delivered", recipients:1}}
7. client → PING {id:"p1"}
   server → PONG {replyTo:"p1"}
8. either side closes the socket; presence records are removed and the TTL cleans
   up anything a crash left behind.
```
