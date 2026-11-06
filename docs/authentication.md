# Authentication

This is the flow that turns "a Minecraft client says it is Notch" into "an Ed25519 access token that
says exactly which internal user and session it is". It is the same handshake vanilla Minecraft uses
between a client and a server, re-used here so the client never has to hand us a Mojang access token.

Files: `src/modules/minecraft-auth/**` (handshake), `src/modules/tokens/**` (sessions and tokens),
`src/infrastructure/mojang/client.ts`, `src/infrastructure/crypto/server-hash.ts`,
`src/plugins/auth.ts` (verification of the issued token).

- [Sequence](#sequence)
- [The challenge state machine](#the-challenge-state-machine)
- [Failure modes](#failure-modes)
- [Why a client-supplied UUID is never trusted](#why-a-client-supplied-uuid-is-never-trusted)
- [Why the Mojang access token never reaches our server](#why-the-mojang-access-token-never-reaches-our-server)
- [The tokens we issue](#the-tokens-we-issue)
- [Refresh rotation](#refresh-rotation)
- [Logout and revocation](#logout-and-revocation)
- [Client implementation checklist](#client-implementation-checklist)

## Sequence

```
 Fabric client (mod + fabric-sdk-java)      auth-server                    Redis        Mojang
             │                                   │                          │            │
 (1) start login                              │                          │            │
             │── POST /api/v1/auth/minecraft/challenge ──────────────────►│            │
             │   { "username": "Notch" }         │                          │            │
             │                                   │ EVAL rate-limit Lua ────►│            │
             │                                   │  auth:rate:uuid:notch    │            │
             │                                   │  auth:rate:ip:{ip}       │            │
             │                                   │ MULTI SET challenge ────►│            │
             │                                   │  auth:challenge:{id}     │            │
             │                                   │  auth:challenge:state:{id} = issued
             │◄── 200 { challengeId, serverId, publicKey, verifyToken, expiresIn } ─────┤
             │                                   │                          │            │
 (2) the client performs the vanilla join      │                          │            │
     it derives a 16-byte AES shared secret    │                          │            │
     and asks Mojang to join with (serverId,   │                          │            │
     sharedSecret) — that call goes directly   │                          │            │
     from the client to Mojang, not through us │                          │            │
             │───────────── join(serverId, sharedSecret) ─────────────────────────────►│
             │◄────────────────────────────── ok ─────────────────────────────────────┤
             │                                   │                          │            │
 (3) verify                                  │                          │            │
             │── POST /api/v1/auth/minecraft/verify ─────────────────────►│            │
             │   { challengeId, username,        │                          │            │
             │     encryptedSharedSecret:        │                          │            │
             │       RSA_PKCS1(publicKey, secret),                          │            │
             │     encryptedVerifyToken:                                    │            │
             │       RSA_PKCS1(publicKey, token) }                          │            │
             │                                   │ EVAL consume Lua ───────►│            │
             │                                   │  GET auth:challenge:{id}, DEL it,
             │                                   │  SET state:{id} = consumed
             │                                   │◄── challenge JSON ───────┤            │
             │                                   │ decrypt both values (private key)
             │                                   │ timingSafeEqual(verifyToken, stored)
             │                                   │ serverId' = signedSha1Hex(salt‖secret‖pubkeyDer)
             │                                   │── GET /session/minecraft/hasJoined ──►│
             │                                   │   ?username&serverId&ip               │
             │                                   │◄── 200 { id, name } | 204 ────────────┤
             │                                   │ upsert user by Mojang UUID
             │                                   │ load effective scopes (MongoDB)
             │                                   │ create session + hashed refresh token
             │◄── 200 { accessToken, refreshToken, tokenType, expiresIn, profile, scopes }
             │                                   │                          │            │
 (4) every later call                          │                          │            │
             │── GET /api/v1/users/me ──────────►│ verify EdDSA, EXISTS revocation key ──►│
             │   Authorization: Bearer <access>  │ reload session + user + scopes from Mongo
             │◄── 200 { user, scopes } ──────────┤                          │            │
```

Three properties of this diagram are the whole security story:

1. The **only** thing that proves identity is Mojang's answer to `hasJoined`. Everything the client
   sends before that answer is either a lookup key (`challengeId`), a claim to be checked
   (`username`), or ciphertext we must decrypt with our own private key.
2. The client never sends us the Mojang access token, and we never ask for it. The vanilla `join` call
   is between the client and Mojang.
3. The shared secret exists only long enough to be hashed into `serverId'`. It is not persisted, not
   logged, and the access token has nothing to do with it.

## The challenge state machine

Two Redis keys describe one challenge:

| Key | Value | TTL |
| --- | --- | --- |
| `auth:challenge:{id}` | JSON record (`status: "PENDING"`, username, `serverId`, verify token, `createdAt`, `expiresAt`) | `CHALLENGE_TTL_SECONDS` (default 60) |
| `auth:challenge:state:{id}` | terminal marker: `issued` → `consumed` \| `expired` | challenge TTL + 600 s |

The marker exists so a late client gets an honest answer (`CHALLENGE_CONSUMED` / `CHALLENGE_EXPIRED`)
instead of a misleading "not found". It is not a credential: the payload key is the only one that can
authorise a login.

```
                     POST /auth/minecraft/challenge
                     (rate limit passed, record stored)
                                 │
                                 ▼
                        ┌─────────────────┐
                        │    CREATED      │  auth:challenge:{id}     = {... status:"PENDING"}
                        │   (PENDING)     │  auth:challenge:state:{id} = "issued"
                        └────────┬────────┘
                    verify      │        │  TTL elapses, or stored expiresAt is in the past
                  (Mojang 200)  │        │
                                ▼        ▼
                    ┌───────────────┐  ┌──────────────┐
                    │   VERIFIED    │  │   EXPIRED    │
                    │ payload DEL'd │  │ payload gone │
                    │ state=consumed│  │ state=issued │
                    │ session+JWT   │  │  / expired   │
                    └───────────────┘  └──────────────┘

   Any verify that consumed the challenge but then failed (username mismatch, unreadable
   ciphertext, verify-token mismatch, wrong secret length, Mojang said "no session",
   Mojang unreachable):

                        ┌─────────────────┐
                        │    REJECTED     │  payload DEL'd, state="consumed",
                        │                 │  audit event auth.challenge.rejected
                        └─────────────────┘
```

Transitions, precisely:

| From | Event | To | Client sees |
| --- | --- | --- | --- |
| — | challenge created | CREATED (PENDING) | `200` + challenge bundle |
| CREATED | verify, all checks pass | VERIFIED | `200` + token pair |
| CREATED | verify, any check fails after consumption | REJECTED | `400` / `401` / `403` / `503` (challenge is gone) |
| CREATED | TTL passes | EXPIRED | `410 CHALLENGE_EXPIRED` |
| CREATED | concurrent second verify | REJECTED for the loser | `409 CHALLENGE_CONSUMED` |
| VERIFIED / REJECTED | any later verify | — | `409 CHALLENGE_CONSUMED` |
| EXPIRED | any later verify | — | `410 CHALLENGE_EXPIRED` |
| — | verify for an unknown id | — | `404 CHALLENGE_NOT_FOUND` |

Two consequences every client must implement:

- **The challenge is single-use, and a failed verify burns it.** Only `429 RATE_LIMITED` and
  `404 CHALLENGE_NOT_FOUND` leave it usable — the rate limit is evaluated *before* the atomic consume.
  After any other verify error the client must request a fresh challenge.
- **Two concurrent verifies cannot both win.** The consume step is a single Redis Lua script
  (`GET` + `DEL` + `SET` marker) so it is atomic across processes; the loser sees
  `CHALLENGE_CONSUMED`, never a second token pair.

## Failure modes

Every failure below is fail-closed: no token is issued. `retryable` is the value in the error
envelope, and it tells a client whether retrying the *same* request can ever succeed.

### POST /api/v1/auth/minecraft/challenge

| Condition | Status | Code | Retryable | Challenge burned |
| --- | --- | --- | --- | --- |
| Body fails validation (username not 3-16 `[A-Za-z0-9_]`, wrong `client`) | 400 | `INVALID_REQUEST` | no | n/a |
| Rate limit hit (per username or per IP, `RATE_LIMIT_CHALLENGE_MAX` per window) | 429 | `RATE_LIMITED` | yes (`details.retryAfterSeconds`, `Retry-After`) | n/a |
| Redis unavailable | 500 | `INTERNAL` | no | n/a |

### POST /api/v1/auth/minecraft/verify

Order matters here — the client should assume the challenge is burned as soon as anything other than a
rate-limit error comes back.

| Condition | Status | Code | Retryable | Challenge burned |
| --- | --- | --- | --- | --- |
| Body fails validation | 400 | `INVALID_REQUEST` | no | **no** (rejected before consume) |
| Rate limit hit (`RATE_LIMIT_VERIFY_MAX`) | 429 | `RATE_LIMITED` | yes | **no** (checked before consume) |
| Unknown challenge id | 404 | `CHALLENGE_NOT_FOUND` | no | n/a |
| Already consumed (including a concurrent verify) | 409 | `CHALLENGE_CONSUMED` | no | already gone |
| TTL elapsed | 410 | `CHALLENGE_EXPIRED` | no | already gone |
| Challenge issued for a different username | 400 | `INVALID_REQUEST` | no | yes |
| Ciphertext not strict base64 / not RSA-decryptable / empty | 400 | `INVALID_REQUEST` ("Encrypted payload could not be processed") | no | yes |
| Decrypted verify token ≠ the challenge's token | 400 | `INVALID_REQUEST` | no | yes |
| Decrypted shared secret ≠ 16 bytes | 400 | `INVALID_REQUEST` | no | yes |
| Mojang: no such session (204 or 4xx after retries) | 401 | `NOT_A_PREMIUM_SESSION` | no | yes |
| Mojang: transport error / timeout / 5xx (after retries) | 503 | `MOJANG_UNAVAILABLE` | **yes** (with a *new* challenge) | yes |
| Account is banned | 403 | `USER_BANNED` | no | yes |

Note the one deliberate subtlety: `MOJANG_UNAVAILABLE` is retryable, but the retry needs a new
challenge because the old one is consumed. A client that blindly retries the same verify call will get
`409 CHALLENGE_CONSUMED`.

### POST /api/v1/auth/refresh

| Condition | Status | Code | Retryable |
| --- | --- | --- | --- |
| Body fails validation (token < 20 or > 512 chars) | 400 | `INVALID_REQUEST` | no |
| Token hash not in `refresh_tokens` | 401 | `UNAUTHORIZED` | no |
| Token expired (session still alive) | 401 | `UNAUTHORIZED` ("Refresh token has expired") | no |
| Session revoked or expired | 401 | `SESSION_REVOKED` | no |
| Token already used while the session is live (**theft signal**) | 401 | `REFRESH_REUSED` | no |
| Account banned | 403 | `USER_BANNED` | no |

### POST /api/v1/auth/logout and every `/api/v1/**` protected route

| Condition | Status | Code |
| --- | --- | --- |
| No `Authorization: Bearer …` header | 401 | `UNAUTHORIZED` |
| Bad signature / wrong issuer / wrong audience / malformed | 401 | `UNAUTHORIZED` |
| Expired access token | 401 | `TOKEN_EXPIRED` (retryable — via `/auth/refresh`) |
| Session revoked, unknown, or expired | 401 | `SESSION_REVOKED` |
| User missing | 401 | `UNAUTHORIZED` |
| Account banned | 403 | `USER_BANNED` |
| Missing required scope (`admin:users` on admin routes) | 403 | `FORBIDDEN` |

The full cross-endpoint error table lives in [api.md](api.md#error-envelope).

## Why a client-supplied UUID is never trusted

The verify request schema (`verifyRequestSchema` in `@skymatrix/api-contract`) is:

```ts
{ challengeId, username, encryptedSharedSecret, encryptedVerifyToken }
```

There is no UUID field. There is nowhere to put one. That is a design decision, not an omission:

1. **A UUID is data, not proof.** Anything the client can type, an attacker can type. Accepting
   `uuid` from a request would mean "whoever names a player becomes that player".
2. **The identity is produced by Mojang, inside the same request.** `hasJoined()` returns
   `{ uuid, username }` derived from Mojang's own record for the session that was just joined. That
   answer is the first and only time the platform learns a UUID.
3. **The username is only a lookup claim.** It is bound to the challenge at creation, compared
   case-insensitively at verify (`sameUsername`), and then *superseded* by Mojang's answer; the user
   row is keyed on `minecraftUuid` and the username column is display data that gets refreshed on each
   login (players rename).
4. **Downstream, the UUID never comes from a request either.** The access token's `sub` is the internal
   Mongo `_id`; `minecraft_uuid` is a convenience claim; the auth guard reloads the user document and
   takes `minecraftUuid` from the database, so even a tampered claim cannot change who the request
   acts as (and it cannot be tampered with anyway — the token is signed).

## Why the Mojang access token never reaches our server

In the vanilla protocol, a client joining a server asks Mojang to `join` with the server's ID and the
shared secret. The *server* then independently asks Mojang `hasJoined`. The client's Mojang access token
is used by the client, against Mojang, and never by the server. We keep exactly that shape:

- The verify request has no field for a Mojang token, and the server never requests one.
- `hasJoined()` is an outbound **server→Mojang** GET:
  `/session/minecraft/hasJoined?username=…&serverId=…&ip=…`.
- The only client-supplied cryptographic material is RSA ciphertext addressed to our public key
  (the per-challenge AES secret and the verify token). The plaintext never leaves the process: the
  secret is hashed into `serverId'`, the verify token is compared and discarded.

The benefit is the point of the whole exercise: **a compromised Skymatrix service cannot be replayed
against Mojang or against other Minecraft servers**, because it never holds a Mojang credential. The
Fabric SDK keeps the Mojang session on the client side (`SessionProvider`).

Two details that matter for correctness of the hash:

- `serverId'` is `signedSha1Hex(serverId ‖ sharedSecretBytes ‖ publicKeyDer)` — the *signed* 160-bit
  hex form vanilla uses (negative values keep a leading `-`), implemented in
  `infrastructure/crypto/server-hash.ts`.
- The RSA public key we advertise (`publicKey`, base64 SubjectPublicKeyInfo DER) must be byte-identical
  to the one hashed into `serverId'`. Both come from `ctx.keys.minecraft`, so they cannot drift; it is
  also why the Minecraft key pair is stable across restarts (env PEM or `service_keys`) and why clients
  may cache it.

## The tokens we issue

**Access token** — a compact JWT signed with Ed25519 (`alg: EdDSA`, `kid` = JWK thumbprint):

| Claim | Meaning |
| --- | --- |
| `iss` | `JWT_ISSUER` (defaults to `PUBLIC_BASE_URL`) |
| `aud` | `[JWT_AUDIENCE]` (default `skymatrix-api`) |
| `sub` | internal MongoDB user id — **not** the Minecraft UUID |
| `minecraft_uuid` | Mojang UUID (convenience for clients; the server re-reads it from the DB) |
| `sid` | session id — what makes revocation possible at all |
| `jti` | random UUID, unique per token |
| `scope` | space-separated scopes **as known at issue time** — informational, never authoritative |
| `iat` / `exp` | `ACCESS_TOKEN_TTL_SECONDS` (default 900 s) |

Published as JWKS at `GET /api/v1/auth/jwks` (`{ keys: [ publicJwk ] }` with `kid`, `use: "sig"`,
`alg: "EdDSA"`). Any other service can verify tokens offline with that key; see
[security.md](security.md#local-verification-by-other-services) for what such a service gives up.

**Refresh token** — 32 random bytes, base64url, opaque. The database stores only
`sha256(token)` (hex) in `refresh_tokens.tokenHash`. It is bound to one session, rotated on every use,
and its lifetime equals the session lifetime (`REFRESH_TOKEN_TTL_DAYS`, default 7 days).

## Refresh rotation

```
 client                      auth-server                         MongoDB
    │  POST /auth/refresh        │                                  │
    │  { refreshToken: R1 }      │                                  │
    │───────────────────────────►│ sha256(R1) → findOne(tokenHash) ─►│
    │                            │◄── token row + session row ──────│
    │                            │ evaluateRefresh(...)              │
    │                            │   not-found     → 401 UNAUTHORIZED
    │                            │   session dead  → 401 SESSION_REVOKED
    │                            │   token expired → 401 UNAUTHORIZED
    │                            │   token used    → 401 REFRESH_REUSED (+ revoke session)
    │                            │   ok            → claim the row atomically:
    │                            │      findOneAndUpdate({_id, usedAt:null, revokedAt:null},
    │                            │                      {$set:{usedAt: now, replacedByHash: h(R2)}})
    │                            │◄── claimed / lost race ──────────│
    │                            │ insert R2, sign new access token  │
    │◄── { newAccess, R2 } ──────│                                  │
```

Why this is safe:

- **Atomic single use.** The compare-and-set only succeeds for one caller. A second concurrent attempt
  fails to claim the row and is treated exactly like a replay.
- **Reuse = compromise.** A token that is still live but already used can only mean two parties hold
  it. The session is revoked immediately (`revokedReason: refresh_token_reuse`), the event
  `auth.refresh.reused` is audited, and the caller gets `REFRESH_REUSED`. This deliberately punishes
  the legitimate user too — they must log in again — which is the correct trade: detection beats a
  silent long-lived hijack.
- **Expiry is re-checked in code.** The `refresh_tokens` TTL index is housekeeping; the decision comes
  from `refresh-policy.ts` plus the session document (see [database.md](database.md#ttl-indexes-and-the-lag-caveat)).
- **Rotation never pages Mojang.** A Mojang outage does not break refresh, only new logins.

Practical client rule: serialise refreshes. Two parallel refreshes with the same token will trigger
reuse detection and log the user out. A single-flight refresh in the SDK is required.

## Logout and revocation

`POST /api/v1/auth/logout` (Bearer required) revokes the current session:

1. `sessions.revokedAt = now`, `revokedReason = "user_logout"` (authoritative),
2. every live `refresh_tokens` row of that session gets `revokedAt = now`,
3. `SET auth:session:revoked:{sid} "1" EX <seconds until the access token expires>` (fast path),
4. audit `auth.session.revoked`; response is `204 No Content`.

The same three steps run for an admin ban (`revokedReason: user_banned`) and for an admin session
revocation (`admin_revoked`), which is why a ban takes effect on the victim's very next request instead
of at token expiry. The guard checks, in this order:

1. the user document — a banned account is rejected with `403 USER_BANNED` **before** session state is
   consulted (a ban also revokes sessions, and a banned caller needs the actionable code, not a generic
   "log in again"),
2. `EXISTS auth:session:revoked:{sid}` (usually a hit — Redis),
3. the session document, which must exist, belong to the subject and carry no `revokedAt`.

## Client implementation checklist

1. Request a challenge, keep `challengeId`; never cache it beyond one verify attempt.
2. Perform the vanilla join with the returned `serverId` and the advertised `publicKey` **exactly as
   received** (base64 standard, not base64url). Derive a 16-byte secret, RSA-encrypt (PKCS#1 v1.5) the
   secret and the decoded `verifyToken`, and POST them base64-standard encoded.
3. On success store `refreshToken` securely and use `accessToken` as `Authorization: Bearer …` until
   `expiresIn`.
4. Refresh with single-flight semantics; on `REFRESH_REUSED` or `SESSION_REVOKED`, discard tokens and
   re-run the challenge flow.
5. Treat every error as terminal for the current challenge except `429 RATE_LIMITED`, and honour
   `details.retryAfterSeconds` / the `Retry-After` header.
6. Never send the Mojang access token to this API, and never log it alongside our tokens.
