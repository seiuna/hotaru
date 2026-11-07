# Database design

MongoDB 7 holds every durable fact in the platform. Redis holds only state that is safe to lose. This
document covers the collections, the indexes and — most importantly — why some indexes are TTL indexes
and why others deliberately are not.

Models live in `apps/auth-server/src/infrastructure/mongo/models/`:

| File | Collections |
| --- | --- |
| `identity.ts` | `users`, `permissions`, `admins` |
| `session.ts` | `sessions`, `refresh_tokens` |
| `ops.ts` | `audit_logs`, `licenses`, `service_keys` |

## Collections

### `users` — one document per premium Minecraft account

| Field | Type | Notes |
| --- | --- | --- |
| `minecraftUuid` | string | Canonical dashed lowercase Mojang UUID. **The identity.** Unique. |
| `username` | string | Display only. Players can rename, so it is never a key. |
| `status` | `active \| banned` | Default `active`. Checked on every authenticated request. |
| `banReason` | string \| null | Free text set by an admin. |
| `bannedAt` | Date \| null | Timestamp of the ban (kept if a second ban arrives). |
| `lastLoginAt` | Date \| null | Updated on successful verification. |
| `createdAt` / `updatedAt` | Date | Mongoose `timestamps: true`. |

Indexes: `{ minecraftUuid: 1 }` **unique**, `{ status: 1 }`, `{ username: 1 }` (non-unique on purpose:
two accounts cannot share a UUID but can, over time, share a name; the name is display data).

### `permissions` — explicit grants, never implicit roles

| Field | Type | Notes |
| --- | --- | --- |
| `userId` | ObjectId → `users` | Who is allowed. |
| `scope` | enum(`SCOPES`) | One of the five scopes from `@hotaru/shared-types`. |
| `expiresAt` | Date \| null | `null` = permanent grant. |
| `grantedBy` | string \| null | Acting admin's user id. |
| `createdAt` / `updatedAt` | Date | `createdAt` is surfaced as `grantedAt`. |

Indexes: `{ userId: 1 }`, `{ userId: 1, scope: 1 }` **unique**, `{ userId: 1, expiresAt: 1 }`.

**No TTL index here, deliberately.** Deleting an expired grant silently would make "who had what, when"
unanswerable. Expiry is enforced in the query instead — the guard only counts grants where
`expiresAt` is `null` or in the future — and expired grants stay visible in `/users/me/permissions`
so they remain auditable.

### `admins` — the administrator roster

| Field | Type | Notes |
| --- | --- | --- |
| `identity` | string | Minecraft UUID of the administrator, unique. |
| `role` | `owner \| admin \| support` | Default `admin`. |
| `createdBy` | string \| null | Who added them. |

Index: `{ identity: 1 }` **unique**.

Note: `admins` is a roster, not an authorization source. Admin API access is granted by the
`admin:users` permission in `permissions`; `scripts/seed-admin.ts` is what creates both the account and
that grant.

### `sessions` — one document per login

| Field | Type | Notes |
| --- | --- | --- |
| `userId` | ObjectId → `users` | Owner. |
| `expiresAt` | Date | `now + REFRESH_TOKEN_TTL_DAYS`. |
| `revokedAt` | Date \| null | Set on logout, admin revocation or ban. |
| `revokedReason` | string \| null | `logout`, `admin_revoked`, `user_banned`, `refresh_token_reuse`, … |
| `ip`, `userAgent` | string \| null | Captured at login for forensics. |
| `createdAt` / `updatedAt` | Date | |

Indexes: `{ userId: 1 }`, `{ userId: 1, expiresAt: -1 }`. **No TTL index** — see the caveat below.

### `refresh_tokens` — rotating, hashed credentials

| Field | Type | Notes |
| --- | --- | --- |
| `sessionId` | ObjectId → `sessions` | Rotation happens inside one session. |
| `userId` | ObjectId → `users` | Denormalised for revocation fan-out. |
| `tokenHash` | string | SHA-256 hex of the opaque token. **Unique.** The raw token is never stored. |
| `expiresAt` | Date | Mirrors the session expiry. |
| `usedAt` | Date \| null | Set exactly once by an atomic compare-and-set during rotation. |
| `replacedByHash` | string \| null | Chain to the successor token, for forensics. |
| `revokedAt` | Date \| null | Set on logout/ban/session revocation. |
| `createdAt` / `updatedAt` | Date | |

Indexes: `{ sessionId: 1 }`, `{ userId: 1 }`, `{ tokenHash: 1 }` **unique**,
`{ expiresAt: 1 }` with `expireAfterSeconds: 0` (TTL).

The `tokenHash` index is the login-critical path: a refresh is a single indexed lookup. Uniqueness also
makes a duplicate token physically impossible.

### `audit_logs` — the security trail

| Field | Type | Notes |
| --- | --- | --- |
| `event` | string | e.g. `auth.challenge.created`, `auth.session.created`, `auth.refresh.reused`, `user.banned`. |
| `actorId` | ObjectId \| null | Acting user or admin. |
| `actorType` | `user \| admin \| system` | Default `system`. |
| `targetType` / `targetId` | string \| null | What was acted on (`user`, `session`, …). |
| `ip` | string \| null | First `X-Forwarded-For` hop. |
| `metadata` | Mixed \| null | Event-specific JSON (scopes, reasons, counts). |
| `createdAt` | Date | No `updatedAt`: audit rows are immutable. |

Indexes: `{ event: 1 }`, `{ actorId: 1 }`, `{ createdAt: -1 }` (newest-first listing),
`{ createdAt: 1 }` with `expireAfterSeconds: 15552000` (180 days).

The 180-day TTL is **retention**, not correctness: losing old audit rows is acceptable, losing recent
ones is not. Audit writes are best-effort by design (`recordAudit` swallows and logs persistence
failures) so an audit outage can never take down the login path — the offsetting trade-off is that a
silent audit gap is possible under a Mongo outage and is only visible in the server log.

### `licenses` — reserved for the product/licensing surface

| Field | Type | Notes |
| --- | --- | --- |
| `userId` | ObjectId → `users` | Owner. |
| `product` | string | Product identifier. |
| `status` | `active \| expired \| revoked` | Default `active`. |
| `expiresAt` | Date \| null | `null` = perpetual. |

Index: `{ userId: 1, product: 1 }` **unique**.

No route uses this collection yet; it exists so the licensing scope (`hotaru:license`) has a home.

### `service_keys` — long-lived crypto material

| Field | Type | Notes |
| --- | --- | --- |
| `purpose` | string | `jwt-ed25519` or `minecraft-rsa`. **Unique.** |
| `alg` | string | `EdDSA` or `RSA-1024`. |
| `kid` | string | Key id; equals the purpose today. |
| `privatePem` / `publicPem` | string | PEM text. |

Index: `{ purpose: 1 }` **unique**.

This collection is only written when no env PEM is configured. Production should inject
`JWT_PRIVATE_KEY_PEM` / `JWT_PUBLIC_KEY_PEM` / `MINECRAFT_RSA_PRIVATE_KEY_PEM` /
`MINECRAFT_RSA_PUBLIC_KEY_PEM` so the private key never rests in a database that other services can
read — see [deployment.md](deployment.md#key-rotation).

## TTL indexes and the lag caveat

Two TTL indexes exist:

| Collection | Index | Effect |
| --- | --- | --- |
| `refresh_tokens` | `{ expiresAt: 1 }`, `expireAfterSeconds: 0` | Rows disappear at most ~60 s after `expiresAt` |
| `audit_logs` | `{ createdAt: 1 }`, `expireAfterSeconds: 15552000` | Rows disappear ~180 days after creation |

**MongoDB TTL deletion is not a security control.** The TTL monitor runs as a background task
(roughly every 60 seconds) on the primary of a replica set, and it only deletes — it never mutates. So a
row can outlive its `expiresAt` by a minute, and a TTL index can be entirely absent (a restore from
backup, a fresh database created without indexes) without anything failing loudly.

Therefore every expiry decision is re-checked in application code:

| Check | Where | Fails closed how |
| --- | --- | --- |
| Session still valid | `plugins/auth.ts` — `session.expiresAt.getTime() <= Date.now()` | `SESSION_REVOKED` |
| Session revoked | `plugins/auth.ts` — `session.revokedAt` | `SESSION_REVOKED` |
| Refresh token expired / session expired | `modules/tokens/refresh-policy.ts` | `UNAUTHORIZED` / `SESSION_REVOKED` |
| Refresh token reuse | `refresh-policy.ts` (`usedAt !== null` while live) + atomic `findOneAndUpdate` | `REFRESH_REUSED`, session revoked |
| Permission expired | Guard and `users/service.ts` filter `expiresAt` in the query | Scope simply not granted |
| Audit retention | TTL only | Not security relevant |

A useful sanity rule: **if a TTL index were dropped right now, the platform would still be correct.**
It would only accumulate rows.

## Index creation in production

Two mechanisms exist, and they must not be confused:

| Mechanism | When it runs | What it does |
| --- | --- | --- |
| Mongoose `autoIndex` | `connectMongo()` — **disabled when `NODE_ENV=production`** | Background index build per model on connect. Off in production on purpose: boot stays predictable and does not block on large collections. |
| `ensureIndexes()` (`src/infrastructure/mongo/indexes.ts`) | `server.ts` at boot, when `MONGODB_ENSURE_INDEXES` is `true` (default) | Calls `Model.createIndexes()` for all eight models. **Additive**: it creates missing indexes and never drops one that exists in the database but not in the schema. |

So a fresh production database gets the unique constraints (`users.minecraftUuid`,
`permissions(userId, scope)`, `refresh_tokens.tokenHash`, `admins.identity`, `service_keys.purpose`,
`licenses(userId, product)`) **before the service accepts traffic** — they are correctness requirements,
not optimisations, and without them duplicate grants and duplicate sessions become possible.

If boot-time creation must not happen in a particular environment (a very large collection, a
maintenance window, a read-only replica), set `MONGODB_ENSURE_INDEXES=false` and create the indexes
manually with `mongosh` against the production database:

```javascript
// mongosh "mongodb://<user>:<password>@127.0.0.1:27017/hotaru_auth?authSource=admin"
const db = db.getSiblingDB('hotaru_auth');

db.users.createIndex({ minecraftUuid: 1 }, { unique: true });
db.users.createIndex({ status: 1 });
db.users.createIndex({ username: 1 });

db.permissions.createIndex({ userId: 1 });
db.permissions.createIndex({ userId: 1, scope: 1 }, { unique: true });
db.permissions.createIndex({ userId: 1, expiresAt: 1 });

db.admins.createIndex({ identity: 1 }, { unique: true });

db.sessions.createIndex({ userId: 1 });
db.sessions.createIndex({ userId: 1, expiresAt: -1 });

db.refresh_tokens.createIndex({ sessionId: 1 });
db.refresh_tokens.createIndex({ userId: 1 });
db.refresh_tokens.createIndex({ tokenHash: 1 }, { unique: true });
db.refresh_tokens.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

db.audit_logs.createIndex({ event: 1 });
db.audit_logs.createIndex({ actorId: 1 });
db.audit_logs.createIndex({ createdAt: -1 });
db.audit_logs.createIndex({ createdAt: 1 }, { expireAfterSeconds: 15552000 });

db.licenses.createIndex({ userId: 1 });
db.licenses.createIndex({ userId: 1, product: 1 }, { unique: true });

db.service_keys.createIndex({ purpose: 1 }, { unique: true });
```

Verify with `db.users.getIndexes()` etc.; every index above must be present before the service takes
production traffic, because the guard's session/user lookups and the refresh-token lookup all assume
them. `createIndexes()` is idempotent, so re-running `ensureIndexes()` (a normal restart with
`MONGODB_ENSURE_INDEXES=true`) is always safe and is the normal repair path after a restore or a model
change.

## Data-handling rules

The following must never be written to MongoDB, Redis or a log line:

- Mojang access tokens (they never reach this service at all),
- shared secrets and verify tokens from the RSA handshake,
- raw refresh tokens (only the SHA-256 hash is stored),
- RSA/Ed25519 private keys in any log or error message.

`AuditLogModel` metadata is deliberately free-form, but callers pass only identifiers, scopes, reasons
and counts — see `recordAudit()` call sites.

## Backup and restore notes

- `mongodump`/`mongorestore` is enough for this dataset; it is small (users, sessions, audit).
- A restored `service_keys` collection keeps the same JWKS and Minecraft public key, so clients do not
  have to re-authenticate. Losing it while running without env PEMs means new keys → every access
  token becomes unverifiable and every Minecraft client must fetch the new public key with a new
  challenge.
- Redis needs no backup: every key is reconstructible (challenges are re-requested, rate limits reset,
  revocation keys are rebuilt from `sessions` on the next ban/revocation… and the session check is
  authoritative regardless).
