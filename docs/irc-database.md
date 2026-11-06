# IRC server — data model and storage

The IRC server persists **configuration and identity metadata only**: groups,
memberships, filter rules and an audit trail. It deliberately does **not** store
chat messages — a message exists only in memory between two live sockets, and the
only trace of it that survives is a short-lived replay-suppression fingerprint in
Redis and audit metadata (message id, recipient count), never the payload.

- Connection: `src/infrastructure/mongo/connection.ts` (Mongoose 8)
- Models: `src/modules/{groups,filters,audit}/model.ts`
- Redis usage: `src/runtime/{presence,dedupe}.ts`

---

## 1. Where the data lives

| Store | Purpose | Shared with |
| --- | --- | --- |
| MongoDB `skymatrix_irc` (`MONGODB_DB`) | groups, memberships, filter rules, audit log | same MongoDB **server** as the auth server, different database |
| Redis db 0 (`REDIS_URL`) | presence records, replay-suppression keys, revocation fast path | **the same Redis instance** as the auth server |

Local development (per [irc-contract.md](./irc-contract.md)): MongoDB
`mongodb://127.0.0.1:27017`, Redis `redis://127.0.0.1:16379` (container
`skymatrix-redis`; port 6379 cannot be published on this host).

In the compose stack both are reachable only on the internal Docker network
(`mongo:27017`, `redis:6379`) and are never published to the host.

The IRC database is separate from `skymatrix_auth`. Nothing in the IRC server
joins across databases: the only cross-database identifiers are the Mojang UUIDs
and internal user ids carried in JWTs.

---

## 2. Collections

Four collections are implemented today. They are all created lazily by Mongoose
on first write; nothing is seeded at boot.

### 2.1 `irc_groups`

One document per group.

| Field | Type | Notes |
| --- | --- | --- |
| `_id` | ObjectId | storage id, never exposed |
| `groupId` | string | public id `grp_<16 url-safe chars>`; unique |
| `name` | string | 1–64 chars; display only, duplicates allowed |
| `ownerUuid` | string | canonical lowercase dashed Mojang UUID |
| `visibility` | enum | `PRIVATE` (default) or `PUBLIC` |
| `maxMembers` | number | ≥ 2, capped at `MAX_GROUP_MEMBERS` |
| `status` | enum | `ACTIVE` or `DELETED` |
| `deletedAt` | Date \| null | set on soft delete |
| `createdAt`, `updatedAt` | Date | Mongoose timestamps |

Indexes:

| Index | Why |
| --- | --- |
| `{ groupId: 1 }` **unique** | public identity; also the idempotency guard for creation |
| `{ ownerUuid: 1, status: 1 }` | "groups I own" and owner-facing listings |
| `{ status: 1, visibility: 1, updatedAt: -1 }` | browsing public groups, newest first |

Groups are **soft-deleted**: `DELETE /v1/groups/:id` sets `status: DELETED` and
removes memberships, so an id is never recycled and an audit row keeps pointing
at something real. Every decision path filters `status: 'ACTIVE'`, so a leaked
soft-deleted document can never authorise a message.

### 2.2 `irc_group_members`

One document per (group, member).

| Field | Type | Notes |
| --- | --- | --- |
| `groupId` | string | references `irc_groups.groupId` (not `_id`) |
| `userUuid` | string | canonical lowercase dashed Mojang UUID |
| `role` | enum | `OWNER`, `ADMIN`, `MEMBER` |
| `joinedAt` | Date | creation timestamp (`timestamps.createdAt`) |

Indexes:

| Index | Why |
| --- | --- |
| `{ groupId: 1, userUuid: 1 }` **unique** | one membership per player; also the idempotency guard for concurrent invites |
| `{ userUuid: 1, groupId: 1 }` | "groups I belong to" (the REST list) and presence co-membership checks |

There is no `updatedAt`: a membership is never edited, only created or removed.
Membership documents are deleted when a group is deleted — a deleted group must
not authorise anything, and stale memberships would still drive presence checks.

### 2.3 `irc_filter_rules`

One document per rule, keyed by scope.

| Field | Type | Notes |
| --- | --- | --- |
| `scope` | enum | `GLOBAL`, `GROUP`, `USER` |
| `targetId` | string \| null | `null` for GLOBAL, `groupId` for GROUP, user UUID for USER |
| `pattern` | string | validated pattern (`chat.message`, `chat.*`, `*`) |
| `action` | enum | `ALLOW` or `DENY` |
| `enabled` | boolean | default `true`; disabled rules are ignored, not deleted |
| `createdBy` | string \| null | actor UUID of the last replacement |
| `createdAt`, `updatedAt` | Date | Mongoose timestamps |

Indexes:

| Index | Why |
| --- | --- |
| `{ scope: 1, targetId: 1, pattern: 1, action: 1 }` **unique** | one row per rule; makes a set-replacement idempotent |
| `{ scope: 1, targetId: 1, enabled: 1 }` | the evaluation path: load one scope's enabled rules |

Rules are replaced as a **set** (`PUT`), never edited individually: the evaluator
loads a whole scope at once, and a half-applied set would be a security-relevant
intermediate state. At most 100 rules per scope (`MAX_RULES_PER_SCOPE`).

`targetId: null` is a normal indexed value in MongoDB, so the unique index still
distinguishes global rules from targeted ones.

### 2.4 `irc_audit_logs`

The security trail. Append-only, identifiers and decisions only.

| Field | Type | Notes |
| --- | --- | --- |
| `event` | string | `group.created`, `filter.rules.updated`, `irc.broadcast.sent`, … |
| `actorUuid` | string \| null | who acted (null for system events) |
| `targetType` | string \| null | `group`, `user`, `global`, `type` |
| `targetId` | string \| null | group id / UUID / message type |
| `ip` | string \| null | client IP from the trusted `X-Forwarded-For` hop |
| `metadata` | object \| null | bounded, sanitised identifiers/counters — never content |
| `createdAt` | Date | creation timestamp only; rows are immutable |

Indexes:

| Index | Why |
| --- | --- |
| `{ createdAt: 1 }` with `expireAfterSeconds: 2592000` | **TTL index**: rows are deleted 30 days after creation |
| `{ event: 1, createdAt: -1 }` | "recent events of type X" |
| `{ actorUuid: 1, createdAt: -1 }` | "what did this player do" |
| `{ targetType: 1, targetId: 1, createdAt: -1 }` | "what happened to this group/user" |

The document shape has no payload field, and `audit/service.ts` sanitises
`metadata` on write so a caller cannot smuggle message content into a log that
lives for 30 days.

---

## 3. Redis keys (not MongoDB, but part of the model)

Redis holds ephemeral state only; losing it degrades features, it does not lose
records.

| Key | Type | TTL | Written by |
| --- | --- | --- | --- |
| `irc:presence:conn:{connectionId}` | JSON string | `PRESENCE_TTL_MS` (90 s), refreshed on every pong | `PresenceStore.register`/`touch` |
| `irc:presence:user:{minecraftUuid}` | set of connectionIds | same, refreshed | presence |
| `irc:presence:instance:{instanceId}` | set of connectionIds | same, refreshed | presence |
| `irc:dedupe:{senderUserId}:{messageId}` | JSON `{fingerprint, at}` | `DEDUPE_TTL_MS` (120 s) | `DedupeStore.begin` |
| `irc:ratelimit:creategroup:{uuid}:{window}` | counter (INCR) | 1 hour (PEXPIRE on every increment) | group-creation quota |
| `auth:session:revoked:{sessionId}` | string | written by the **auth server** on logout/ban/refresh-reuse | auth server; **read** by the IRC server |

`irc:node:{instanceId}` is defined in `presenceKeys` for the future cross-node
pub/sub channel; nothing publishes or subscribes to it in v1.

---

## 4. Indexes and TTL caveats (read this before production)

### 4.1 How the indexes are created

Mongoose's `autoIndex` is **off** in production (`connectMongo` sets
`autoIndex: config.nodeEnv !== 'production'`), because building indexes on every
boot is a surprise you do not want on a large collection. Instead the server
creates them explicitly:

```ts
// server.ts — before the HTTP listener starts
if (config.ensureIndexes) await ensureIndexes();     // true by default

// infrastructure/mongo/indexes.ts
await IrcGroupModel.createIndexes();
await IrcGroupMemberModel.createIndexes();
await IrcFilterRuleModel.createIndexes();
await IrcAuditLogModel.createIndexes();
```

`createIndexes()` is **additive**: it creates what is missing and never drops an
index an operator added by hand. All indexes in §2 are declared on the models, so
the default `MONGODB_ENSURE_INDEXES=true` gives a production node the unique
constraints and the audit-log TTL on first boot.

Consequences worth knowing:

| Situation | Behaviour |
| --- | --- |
| fresh database, default settings | every index in §2 is created on first boot |
| `MONGODB_ENSURE_INDEXES=false` | nothing is created; you own index management (see the `mongosh` block below) |
| an index *definition* changes between releases | `createIndexes()` does **not** modify an existing index of the same key pattern + options; a real change needs a manual drop/recreate |
| dirty data violates a unique constraint | index creation fails and the process exits non-zero **before** accepting traffic (fail fast, not a silent half-enforced schema) |
| a unique index was missing while duplicates were written | startup fails until the duplicates are removed — check the boot log |

Because index creation runs before `app.listen`, a bad database state is a
deployment failure with a clear log line, not a data corruption discovered later.

If you prefer to manage indexes out-of-band (`MONGODB_ENSURE_INDEXES=false`), run
this once per environment and after every schema change:

```javascript
// mongosh "$MONGODB_URI" --eval '...'   (db = skymatrix_irc)
db.irc_groups.createIndex({ groupId: 1 }, { unique: true })
db.irc_groups.createIndex({ ownerUuid: 1, status: 1 })
db.irc_groups.createIndex({ status: 1, visibility: 1, updatedAt: -1 })
db.irc_group_members.createIndex({ groupId: 1, userUuid: 1 }, { unique: true })
db.irc_group_members.createIndex({ userUuid: 1, groupId: 1 })
db.irc_filter_rules.createIndex({ scope: 1, targetId: 1, pattern: 1, action: 1 }, { unique: true })
db.irc_filter_rules.createIndex({ scope: 1, targetId: 1, enabled: 1 })
db.irc_audit_logs.createIndex({ createdAt: 1 }, { expireAfterSeconds: 2592000 })
db.irc_audit_logs.createIndex({ event: 1, createdAt: -1 })
db.irc_audit_logs.createIndex({ actorUuid: 1, createdAt: -1 })
db.irc_audit_logs.createIndex({ targetType: 1, targetId: 1, createdAt: -1 })
```

### 4.2 TTL deletion is lazy and coarse

- MongoDB's TTL monitor runs roughly every 60 seconds; an expired audit row can
  outlive its expiry by up to a minute. It is **not** a precise scheduler.
- The TTL is anchored on `createdAt`, so retention is always "30 days after the
  record was written", never "30 days after the group was deleted".
- A TTL index cannot be combined with a `status` filter: soft-deleted groups are
  kept forever (that is intentional — the audit trail references them).

### 4.3 Presence is TTL, not truth

A presence set member is never proof of life: `isOnline` checks that the concrete
`irc:presence:conn:{id}` record still exists. A crashed node leaves records that
expire within `PRESENCE_TTL_MS`, and a sweeper prunes the orphaned set members.
Raising `PRESENCE_TTL_MS` widens the "ghost online" window; lowering it below the
heartbeat interval would make healthy connections flap offline.

### 4.4 Dedupe is not exactly-once messaging

The dedupe key lives 120 seconds by default. A reconnect that retries a message
after the window reuses the id without suppression. Dedupe protects against
accidental double-sends and short replay attacks, not against a malicious client
that intentionally re-sends with a fresh id.

### 4.5 What is *not* stored

- No chat message, payload, or delivery log is written to MongoDB.
- The audit log records that a broadcast happened (`irc.broadcast.sent`, with a
  recipient count and message id) and that a type was denied, but never content.
- Redis keys contain user ids/UUIDs and payload *hashes* only.

---

## 5. Sizing and operational notes

| Setting | Value | Location |
| --- | --- | --- |
| Connection pool | `maxPoolSize: 20` | `connectMongo` |
| Server selection timeout | 5 s | `connectMongo` |
| `strictQuery` | on | `connectMongo` |
| Model overwrite guard | `mongoose.models.X ?? model(...)` | every model file (keeps hot reload / tests safe) |
| `versionKey` | disabled | every schema |

Growth is driven by the audit log (bounded by the TTL, once it exists) and by
groups/memberships (bounded by player activity). Filter rules are capped at 100
per scope.

A throwaway database per e2e run is named `skymatrix_irc_e2e_<timestamp>` and is
not dropped automatically; drop it manually if you run the harness often.

---

## 6. Design vs. implementation

The build contract mentions "5 collections". The implementation currently has
**4** (`irc_groups`, `irc_group_members`, `irc_filter_rules`, `irc_audit_logs`);
presence, which the design counted as data, lives entirely in Redis. If a
players/users mirror collection is added later it will be listed here — nothing
in the current code reads one, and the IRC server does not mirror auth users.
