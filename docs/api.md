# HTTP API

Base URL: `PUBLIC_BASE_URL` (production `https://auth.example.com`). All endpoints are under `/api/v1`.
The machine-readable contract is [`docs/openapi.json`](openapi.json) / [`docs/openapi.yaml`](openapi.yaml),
generated from the running app by `pnpm --filter @hotaru/auth-server openapi:export`.

- [Conventions](#conventions)
- [Endpoint summary](#endpoint-summary)
- [Public authentication endpoints](#public-authentication-endpoints)
- [Authenticated user endpoints](#authenticated-user-endpoints)
- [Admin endpoints](#admin-endpoints)
- [Health endpoints](#health-endpoints)
- [Error envelope](#error-envelope)
- [Scopes](#scopes)

## Conventions

| Topic | Rule |
| --- | --- |
| Content type | `application/json` for every request and response body (except `204 No Content`). |
| Body limit | 64 KiB at Fastify, 64 KB at Caddy. Larger bodies are refused before handlers run. |
| Authentication | `Authorization: Bearer <accessToken>` on every route marked 🔒. |
| Response shape | Every response is serialised against its schema; fields not in the schema are dropped, and a response that fails its schema is a `500`. |
| Errors | Always `{ "error": { "code", "message", "retryable", "details"? } }` — see [Error envelope](#error-envelope). Branch on `code`, never on `message`. |
| Rate limits | Challenge and verify are limited per username **and** per IP (`RATE_LIMIT_CHALLENGE_MAX` / `RATE_LIMIT_VERIFY_MAX` per `RATE_LIMIT_WINDOW_SECONDS`, default 10 per 60 s). A `429` carries `details.retryAfterSeconds` and a `Retry-After` header. |
| Ids | User and session ids are 24-char lowercase hex Mongo ObjectIds. A malformed id on an admin route returns `404` (identical to an unknown id, so nothing leaks). |
| Timestamps | ISO-8601 UTC strings, e.g. `"2026-11-06T13:21:00.000Z"`. Nullable where the domain allows it. |
| Pagination | `limit` + `offset` query parameters, response echoes `{ total, limit, offset }`. |
| CORS | Disabled unless `CORS_ORIGINS` is set (comma-separated allow-list); only `content-type` and `authorization` request headers are allowed. |
| Interactive docs | `/docs` (Swagger UI) is served by the app but **blocked at the edge** by `deploy/Caddyfile`; use it in local development only. |

## Endpoint summary

| # | Method | Path | Auth | Scope | Success |
| --- | --- | --- | --- | --- | --- |
| 1 | POST | `/api/v1/auth/minecraft/challenge` | — | — | `200` challenge |
| 2 | POST | `/api/v1/auth/minecraft/verify` | — | — | `200` token pair |
| 3 | POST | `/api/v1/auth/refresh` | — | — | `200` token pair |
| 4 | POST | `/api/v1/auth/logout` | 🔒 | any | `204` |
| 5 | GET | `/api/v1/auth/jwks` | — | — | `200` JWKS |
| 6 | GET | `/api/v1/users/me` | 🔒 | any | `200` profile + scopes |
| 7 | GET | `/api/v1/users/me/permissions` | 🔒 | any | `200` grants + scopes |
| 8 | GET | `/api/v1/admin/users` | 🔒 | `admin:users` | `200` page of users |
| 9 | PUT | `/api/v1/admin/users/{id}/permissions` | 🔒 | `admin:users` | `200` grants + scopes |
| 10 | POST | `/api/v1/admin/users/{id}/ban` | 🔒 | `admin:users` | `200` user + revoked count |
| 11 | POST | `/api/v1/admin/users/{id}/unban` | 🔒 | `admin:users` | `200` user |
| 12 | POST | `/api/v1/admin/sessions/{id}/revoke` | 🔒 | `admin:users` | `200` session |
| 13 | GET | `/api/v1/admin/audit-logs` | 🔒 | `admin:users` | `200` page of audit entries |
| 14 | GET | `/api/v1/health/live` | — | — | `200` liveness |
| 15 | GET | `/api/v1/health/ready` | — | — | `200` / `503` readiness |

"Auth: 🔒" means the request must carry a valid access token. "Scope: any" means any authenticated user
may call it — no specific permission is required.

## Public authentication endpoints

### 1. `POST /api/v1/auth/minecraft/challenge`

Starts the handshake. The challenge is single-use, bound to the username and expires after
`CHALLENGE_TTL_SECONDS` (default 60 s).

Request:

```json
{ "username": "Notch" }
```

`client` is optional when `CLIENT_KEYS` is empty:

```json
{ "username": "Notch", "client": "fabric" }
```

When `CLIENT_KEYS` is configured, send the registered identity instead. The public key may be base64
SPKI DER or PEM; the server checks its SHA-256 fingerprint and records the identity in the session and
access token.

```json
{
  "username": "Notch",
  "client": {
    "id": "official-mod",
    "version": "1.4.0",
    "publicKey": "MCowBQYDK2VwAyEA..."
  }
}
```

Missing or mismatched identities fail with `CLIENT_REQUIRED`, `CLIENT_UNKNOWN` or
`CLIENT_KEY_MISMATCH`. This identifies a client build; it is not a signature proof and must not be used
as authorization.

Response `200`:

```json
{
  "challengeId": "0f0b0a52-6f5d-4a2e-9f77-0c3c5a1f0b11",
  "serverId": "k3J0m9Qm2m8Xb1rT4wY6uQ",
  "publicKey": "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC7…",
  "verifyToken": "q83vEg==",
  "expiresIn": 60
}
```

| Field | Meaning |
| --- | --- |
| `challengeId` | UUID; send it back in the verify call. |
| `serverId` | Random per-challenge salt (base64url). Pass it to the vanilla `join` call. |
| `publicKey` | Base64 **standard** SubjectPublicKeyInfo DER of the RSA-1024 key. Encrypt the shared secret and the verify token with it (PKCS#1 v1.5). |
| `verifyToken` | Base64 of 4 random bytes. **Decode first**, then encrypt the 4 raw bytes. |
| `expiresIn` | Seconds until the challenge dies. |

Errors: `400 INVALID_REQUEST`, `429 RATE_LIMITED`, `500 INTERNAL`.

### 2. `POST /api/v1/auth/minecraft/verify`

Verifies the encrypted handshake with Mojang and, on success, creates the account (first login) and a
session.

Request:

```json
{
  "challengeId": "0f0b0a52-6f5d-4a2e-9f77-0c3c5a1f0b11",
  "username": "Notch",
  "encryptedSharedSecret": "k3J0m9Qm2m8Xb1rT4wY6uQ…",
  "encryptedVerifyToken": "k3J0m9Qm2m8Xb1rT4wY6uQ…"
}
```

`encryptedSharedSecret` and `encryptedVerifyToken` are base64-standard RSA ciphertext (1–2048 chars).

Response `200`:

```json
{
  "accessToken": "eyJhbGciOiJFZERTQSIsImtpZCI6IjRkOW…",
  "refreshToken": "3mQ9dL2wVn6o0jH8sX1yB4zT7pR5cK2aN9fG1eU6iQ0",
  "tokenType": "Bearer",
  "expiresIn": 900,
  "profile": { "uuid": "069a79f4-44e9-4726-a5be-fca90e38aaf5", "username": "Notch" },
  "scopes": ["hotaru:profile"]
}
```

The profile comes from Mojang's `hasJoined` answer, never from the request.

Errors: `400 INVALID_REQUEST` (bad body, username mismatch, unreadable ciphertext, verify-token
mismatch, wrong secret length), `401 NOT_A_PREMIUM_SESSION`, `403 USER_BANNED`,
`404 CHALLENGE_NOT_FOUND`, `409 CHALLENGE_CONSUMED`, `410 CHALLENGE_EXPIRED`, `429 RATE_LIMITED`,
`503 MOJANG_UNAVAILABLE`. A failed verify burns the challenge — see
[authentication.md](authentication.md#the-challenge-state-machine).

### 3. `POST /api/v1/auth/refresh`

Rotates a refresh token. Unauthenticated by design: the opaque refresh token is the credential.

Request:

```json
{ "refreshToken": "3mQ9dL2wVn6o0jH8sX1yB4zT7pR5cK2aN9fG1eU6iQ0" }
```

Response `200`: same shape as verify (a **new** access token and a **new** refresh token; the presented
one is now dead).

Errors: `400 INVALID_REQUEST`, `401 UNAUTHORIZED` (unknown/expired token), `401 SESSION_REVOKED`,
`401 REFRESH_REUSED` (token replay — the session is revoked), `403 USER_BANNED`.

### 4. `POST /api/v1/auth/logout` 🔒

Revokes the session behind the presented access token (MongoDB + Redis fast path) and the refresh
tokens of that session.

Request: no body. Response: `204 No Content`.

Errors: `401 UNAUTHORIZED`, `401 TOKEN_EXPIRED`, `401 SESSION_REVOKED`, `403 USER_BANNED`.

### 5. `GET /api/v1/auth/jwks`

Public keys for offline access-token verification.

```json
{
  "keys": [
    {
      "kty": "OKP",
      "crv": "Ed25519",
      "x": "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
      "kid": "4d9c1f0a4f5b7c2d…",
      "use": "sig",
      "alg": "EdDSA"
    }
  ]
}
```

Rotating the JWT key pair changes `kid`; verifiers must select the key by `kid` from the token header.

## Authenticated user endpoints

### 6. `GET /api/v1/users/me` 🔒

```json
{
  "user": {
    "id": "66f1b0c2a9d3e4f5b6c7d8e9",
    "minecraftUuid": "069a79f4-44e9-4726-a5be-fca90e38aaf5",
    "username": "Notch",
    "status": "active",
    "createdAt": "2026-11-01T09:12:44.000Z",
    "lastLoginAt": "2026-11-06T13:21:00.000Z"
  },
  "scopes": ["hotaru:profile"]
}
```

`scopes` are recomputed from MongoDB on every request, so they reflect a permission change immediately.

Errors: `401 UNAUTHORIZED`, `401 TOKEN_EXPIRED`, `401 SESSION_REVOKED`, `403 USER_BANNED`.

### 7. `GET /api/v1/users/me/permissions` 🔒

```json
{
  "permissions": [
    {
      "scope": "hotaru:profile",
      "grantedAt": "2026-11-01T09:12:44.000Z",
      "expiresAt": null,
      "grantedBy": null
    },
    {
      "scope": "hotaru:resource",
      "grantedAt": "2026-11-05T18:00:00.000Z",
      "expiresAt": "2026-12-05T18:00:00.000Z",
      "grantedBy": "66f1b0c2a9d3e4f5b6c7d8e9"
    }
  ],
  "scopes": ["hotaru:profile", "hotaru:resource"]
}
```

`permissions` includes expired grants (they stay auditable); `scopes` counts only grants that are
permanent or unexpired. Errors: `401`, `403 USER_BANNED`.

## Admin endpoints

All admin routes require the `admin:users` scope. The guard recomputes scopes from MongoDB per
request, so revoking that permission locks an administrator out on their next call.

### 8. `GET /api/v1/admin/users`

Query parameters:

| Name | Type | Default | Notes |
| --- | --- | --- | --- |
| `query` | string ≤ 64 | — | Case-insensitive username substring, or Minecraft-UUID **prefix**. |
| `status` | `active` \| `banned` | — | Filter by account status. |
| `limit` | int 1–100 | 20 | Page size. |
| `offset` | int ≥ 0 | 0 | Page offset. |

```json
{
  "users": [
    {
      "id": "66f1b0c2a9d3e4f5b6c7d8e9",
      "minecraftUuid": "069a79f4-44e9-4726-a5be-fca90e38aaf5",
      "username": "Notch",
      "status": "active",
      "createdAt": "2026-11-01T09:12:44.000Z",
      "lastLoginAt": "2026-11-06T13:21:00.000Z"
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

Ordering is newest-account-first (`createdAt` desc). Errors: `400 INVALID_REQUEST`, `401`, `403`.

### 9. `PUT /api/v1/admin/users/{id}/permissions`

**Replaces** the user's entire grant set (it is not additive). Maximum 32 entries; duplicate scopes and
`expiresAt` values in the past are rejected with `400`.

```json
{
  "permissions": [
    { "scope": "hotaru:profile" },
    { "scope": "hotaru:resource", "expiresAt": "2026-12-05T18:00:00.000Z" }
  ]
}
```

Sending `{ "permissions": [] }` removes every grant. Response `200` is the same shape as
`GET /users/me/permissions`.

Errors: `400 INVALID_REQUEST`, `401`, `403`, `404 NOT_FOUND` (unknown or malformed user id).

Audit event: `user.permissions.updated` with `added`/`removed`/`updated` scope lists.

### 10. `POST /api/v1/admin/users/{id}/ban`

Bans the account and kills every credential it currently holds: all live sessions get
`revokedAt`/`revokedReason: "user_banned"`, their refresh tokens are revoked, and a Redis revocation key
is written per session so the fast path agrees immediately.

Request (optional body):

```json
{ "reason": "chargeback abuse" }
```

Response `200`:

```json
{
  "user": {
    "id": "66f1b0c2a9d3e4f5b6c7d8e9",
    "minecraftUuid": "069a79f4-44e9-4726-a5be-fca90e38aaf5",
    "username": "Notch",
    "status": "banned",
    "createdAt": "2026-11-01T09:12:44.000Z",
    "lastLoginAt": "2026-11-06T13:21:00.000Z"
  },
  "sessionsRevoked": 2
}
```

Idempotent: banning an already-banned user keeps the original `bannedAt`. Audit event: `user.banned`
(with `revocationKeyFailures` if Redis refused any revocation key — MongoDB is still authoritative).

Errors: `400`, `401`, `403`, `404`.

### 11. `POST /api/v1/admin/users/{id}/unban`

Lifts the ban. Sessions revoked by the ban stay revoked: the user must authenticate again.

Request: no body. Response `200`: `{ "user": { … } }`. Audit event: `user.unbanned`.

Errors: `401`, `403`, `404`.

### 12. `POST /api/v1/admin/sessions/{id}/revoke`

Revokes one session (MongoDB first, then the Redis key). Revoking an already-revoked session is a no-op
apart from refreshing the fast-path key. It does **not** ban the account.

Request (optional body): `{ "reason": "lost laptop" }`

Response `200`:

```json
{
  "session": {
    "id": "66f1b0c2a9d3e4f5b6c7d8ef",
    "createdAt": "2026-11-06T13:21:00.000Z",
    "expiresAt": "2026-11-13T13:21:00.000Z",
    "revokedAt": "2026-11-06T14:02:11.000Z",
    "ip": "203.0.113.42",
    "userAgent": "Minecraft/1.21.4 (Fabric)"
  }
}
```

Audit event: `auth.session.revoked` with `actorType: "admin"`. Errors: `400`, `401`, `403`, `404`.

### 13. `GET /api/v1/admin/audit-logs`

Query parameters:

| Name | Type | Default | Notes |
| --- | --- | --- | --- |
| `event` | string ≤ 64 | — | Exact event name, e.g. `auth.refresh.reused`. |
| `actorId` | 24-hex id | — | Exact actor. |
| `limit` | int 1–200 | 50 | Page size. |
| `offset` | int ≥ 0 | 0 | Page offset. |

```json
{
  "logs": [
    {
      "id": "66f1b0c2a9d3e4f5b6c7d8f0",
      "event": "auth.session.revoked",
      "actorId": "66f1b0c2a9d3e4f5b6c7d8e9",
      "actorType": "admin",
      "targetType": "session",
      "targetId": "66f1b0c2a9d3e4f5b6c7d8ef",
      "ip": "203.0.113.42",
      "metadata": { "reason": "lost laptop", "userId": "66f1b0c2a9d3e4f5b6c7d8e9", "alreadyRevoked": false },
      "createdAt": "2026-11-06T14:02:11.000Z"
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

Newest first. Errors: `400 INVALID_REQUEST`, `401`, `403`.

Audit events emitted by the platform: `auth.challenge.created`, `auth.challenge.rejected`,
`auth.session.created`, `auth.session.refreshed`, `auth.session.revoked`, `auth.refresh.reused`,
`auth.login.banned`, `user.permissions.updated`, `user.banned`, `user.unbanned`, `admin.seeded`.

## Health endpoints

### 14. `GET /api/v1/health/live`

Never touches a dependency, so a restart-on-liveness policy cannot loop on a broken database.

```json
{ "status": "ok", "uptimeSeconds": 137 }
```

### 15. `GET /api/v1/health/ready`

Dependency-aware; use this for load-balancer decisions.

```json
{ "status": "ok", "checks": { "mongo": "ok", "redis": "ok" } }
```

Degraded (`503`, still a valid body):

```json
{ "status": "degraded", "checks": { "mongo": "ok", "redis": "fail" } }
```

Both health routes are public and marked `Cache-Control: no-store` at the edge.

## Error envelope

Every non-2xx response from any endpoint:

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many authentication attempts",
    "retryable": true,
    "details": { "retryAfterSeconds": 42 }
  }
}
```

`details` is optional and shape depends on `code` (validation issues carry
`[{ path, message }, …]`; `RATE_LIMITED` carries `retryAfterSeconds`).

| Code | HTTP | Retryable | Emitted when |
| --- | --- | --- | --- |
| `INVALID_REQUEST` | 400 | no | Body/query/params failed validation; username mismatch; unreadable ciphertext; verify-token mismatch; bad secret length; duplicate scope; `expiresAt` in the past |
| `CHALLENGE_NOT_FOUND` | 404 | no | The challenge id was never issued (or Redis lost it) |
| `CHALLENGE_CONSUMED` | 409 | no | The challenge was already used, including by a concurrent verify |
| `CHALLENGE_EXPIRED` | 410 | no | The challenge TTL elapsed |
| `NOT_A_PREMIUM_SESSION` | 401 | no | Mojang answered "no such session" for this username+serverId |
| `MOJANG_UNAVAILABLE` | 503 | **yes** | Mojang transport error/timeout/5xx after retries — retry with a **new** challenge |
| `RATE_LIMITED` | 429 | **yes** | Per-username or per-IP challenge/verify quota exhausted; see `Retry-After` |
| `UNAUTHORIZED` | 401 | no | Missing/malformed/invalid access token; unknown or expired refresh token; user row missing |
| `TOKEN_EXPIRED` | 401 | **yes** | Access token `exp` passed — call `/auth/refresh` |
| `SESSION_REVOKED` | 401 | no | Session revoked, expired, or missing (logout, ban, admin revoke) |
| `REFRESH_REUSED` | 401 | no | A live refresh token was presented twice; the session is now revoked |
| `USER_BANNED` | 403 | no | Account `status` is `banned` |
| `FORBIDDEN` | 403 | no | Authenticated but missing the required scope |
| `NOT_FOUND` | 404 | no | Unknown route, unknown admin target id, or malformed id on an admin route |
| `INTERNAL` | 500 | no | Unexpected server/dependency failure; details are never leaked |

Two rules for clients:

1. **Branch on `code`.** Messages are human text and may change.
2. **`retryable: true` means retry with backoff** — and for `MOJANG_UNAVAILABLE` that means a new
   challenge first, because the old one is consumed.

## Scopes

| Scope | Grants |
| --- | --- |
| `hotaru:profile` | Read the authenticated account profile (default for every player) |
| `hotaru:resource` | Access the Hotaru mod resource service |
| `hotaru:ircserver` | Connect to the Hotaru IRC service |
| `hotaru:license` | Query software licenses |
| `admin:users` | Administer users, permissions, sessions and read the audit log |

Scopes are granted only by an administrator (`PUT /admin/users/{id}/permissions`) or by the seed script,
and are evaluated from MongoDB on every request. The `scope` claim inside an access token is
informational and must not be trusted by any consumer as the sole authority.
