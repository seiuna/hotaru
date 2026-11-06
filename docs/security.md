# Security

The platform's job is to make a wrong "yes" impossible and a wrong "no" cheap. This document states the
threat model, the control that answers each threat, and the risk that remains after that control.

Files that implement the controls: `src/plugins/auth.ts`, `src/plugins/errors.ts`,
`src/modules/minecraft-auth/{challenge-store,rate-limit,crypto}.ts`,
`src/modules/tokens/{service,refresh-policy}.ts`, `src/infrastructure/crypto/**`,
`deploy/{Caddyfile,compose.yaml}`.

## Security principles

1. **No client claim is authority.** UUID, premium status and scopes are derived from Mojang or
   MongoDB, never from the request body or a token claim.
2. **Fail closed.** Any uncertainty (Mongo down, Redis down, Mojang unreachable, ambiguous refresh
   state, crypto failure) results in no token.
3. **One-shot credentials.** Challenges are consumed atomically; refresh tokens are rotated atomically.
4. **Authority is re-derived per request.** Signature verification is necessary but never sufficient:
   revocation, ban status and scopes are loaded from MongoDB on every call.
5. **Secrets do not transit or rest in logs.** No token, shared secret, verify token or private key is
   logged, and the error envelope never contains internals.
6. **Everything above is tested as a negative case.** `app.inject()` tests prove expired challenge,
   consumed challenge, replayed refresh token, forged UUID, Mojang 5xx and missing scope.

## Threat model

| # | Threat | Control | Residual risk |
| --- | --- | --- | --- |
| 1 | **Replay of a captured verify request** | Challenge is single-use: a Lua script does `GET`+`DEL`+`SET marker` atomically, so only the first verify can ever consume it. Losers get `CHALLENGE_CONSUMED`. | An attacker who captures the ciphertext *and* wins the race against the legitimate client gets that session. Both sides then hold credentials, but the session is bound to the real Mojang account; the window is ≤ `CHALLENGE_TTL_SECONDS` (60 s). |
| 2 | **Forged UUID / impersonation by naming a player** | The verify contract has no UUID field. Identity comes only from Mojang's `hasJoined` answer. The challenge is bound to the username at creation and re-checked case-insensitively. | None via the API surface. A Mojang-side compromise is out of scope. |
| 3 | **Forged verify token / chosen ciphertext attack** | Both ciphertexts are RSA-PKCS#1 v1.5 encrypted to our private key; decrypt failures, base64-invalid input, empty plaintext, and the verify-token mismatch all return the **same** `400 INVALID_REQUEST`, so no decryption oracle exists. Comparison uses `timingSafeEqual`. | The verify token is only 4 bytes (Minecraft protocol convention). It binds a request to a challenge; it is not the security boundary. The boundary is Mojang's positive `hasJoined`. |
| 4 | **Man-in-the-middle on the wire** | TLS terminated by Caddy with automatic Let's Encrypt certificates, HSTS (`max-age=31536000; includeSubDomains; preload`), `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`. The app trusts `X-Forwarded-For` only because the edge overwrites it. | A client that ignores certificate errors, or a hijacked DNS/CA, is outside our control. Clients should pin `PUBLIC_BASE_URL`. |
| 5 | **Access-token theft** | Bearer tokens are short-lived (default 900 s), bound to a session (`sid`), and every request re-checks the session and the user in MongoDB. Logout/ban/admin-revoke kills the session immediately. | A stolen token is replayable until it expires — there is no proof-of-possession (no DPoP/mTLS binding). Mitigate by shortening `ACCESS_TOKEN_TTL_SECONDS`. |
| 6 | **Refresh-token theft** | 32 random bytes, stored only as SHA-256, rotated on every use with an atomic compare-and-set; presenting a used-but-live token is treated as compromise and revokes the session (`REFRESH_REUSED`, audit `auth.refresh.reused`). | If the thief refreshes **before** the legitimate client, the thief holds the new token chain and the real user is logged out; the thief can keep the session alive until the session expiry (default 7 days) as long as only one party refreshes. Mitigate with a shorter `REFRESH_TOKEN_TTL_DAYS` and reuse detection telemetry. |
| 7 | **Ban latency / revocation latency** | The guard loads the user and session from MongoDB on **every** request, so a ban takes effect on the next API call. Ban additionally writes Redis revocation keys for every live session. | **Other services that verify JWTs offline against JWKS will keep accepting a banned user until the access token expires (≤ 900 s).** Only services that call this API (or check `sid` against `/users/me`) get instant revocation. |
| 8 | **Mojang outage or slow response** | Bounded retries (`MOJANG_HAS_JOINED_ATTEMPTS`, delay `MOJANG_RETRY_DELAY_MS`, timeout `MOJANG_HAS_JOINED_TIMEOUT_MS`) then fail closed with retryable `MOJANG_UNAVAILABLE`. Existing sessions and refresh are unaffected (refresh never calls Mojang). | New logins are impossible while Mojang is down — the correct trade. An attacker cannot convert the outage into a login. |
| 9 | **Refresh-token reuse (replay)** | Atomic `findOneAndUpdate({ usedAt: null, revokedAt: null })`; losing the race is treated as replay → session revoked, audit event written. The pure decision table in `refresh-policy.ts` is unit-tested exhaustively. | Legitimate clients that refresh concurrently with the same token will be logged out. Clients must single-flight their refresh. |
| 10 | **Brute force / resource exhaustion on the handshake** | Fixed-window rate limits in Redis (atomic `INCR`+`EXPIRE` Lua) keyed per username and per IP for both challenge and verify (`RATE_LIMIT_*_MAX` per window, default 10/60 s). Caddy caps request bodies at 64 KB and upstream response time at 15 s. | A botnet with many source IPs and many usernames can still consume Mojang quota and CPU. Add an edge/WAF rate limit for hostile networks. |
| 11 | **Privilege escalation via token claims** | Scopes are recomputed from MongoDB on every request; the `scope` claim is informational. Admin routes additionally require `admin:users` from the DB. | An actor with **write access to MongoDB** can grant themselves scopes. That is database compromise; see row 15. |
| 12 | **Admin account takeover** | Admin rights are a DB grant, every admin action is audited (`user.banned`, `user.permissions.updated`, …), sessions can be revoked individually, and bans kill all credentials at once. | There is no second factor: an administrator's security equals their Minecraft account security. Protect the Mojang account (strong password, 2FA), keep the admin roster small, review `admin:users` grants. |
| 13 | **Audit-log tampering** | The service only inserts audit rows (no update/delete path), rows are immutable (`updatedAt` disabled), and they are readable through the admin API. | Anyone with direct database access can delete rows. Ship logs off-host (see [deployment.md](deployment.md#monitoring)) if that matters. |
| 14 | **Malicious/compromised Redis** | Redis holds only ephemeral state. Sessions, users, permissions and refresh tokens live in MongoDB, and the guard's session check is authoritative. A hostile Redis can delete rate limits and revocation keys, but cannot mint authority. | Rate limiting and the revocation fast path degrade (defence in depth only); challenge injection still requires a successful Mojang `hasJoined`. |
| 15 | **Service key disclosure (JWT signing key)** | Env PEMs take precedence over `service_keys`, so production can keep the private key outside the database. The key pair is generated once (never per request/restart) so clients can cache JWKS and the Minecraft public key. | If the key is in `service_keys` and MongoDB is compromised, the attacker can sign tokens — but the guard still requires a live session and a real user row, and scopes still come from the DB. Rotate keys if exposure is suspected; prefer KMS-injected env PEMs. |
| 16 | **Error-message information leak** | `plugins/errors.ts` is the only response builder for failures; unknown errors become `500 INTERNAL` with no message. Validation details name fields, never values. Admin routes return `404` for malformed ids, so "bad id" and "no such id" are indistinguishable. | Validation details reveal the schema — which is public anyway. |
| 17 | **Credential leakage through logs** | Pino redacts `req.headers.authorization` and `req.headers.cookie`. Bodies are never logged. Audit metadata carries identifiers, scopes, reasons and counts only. Caddy's access log redacts `Authorization`/`Cookie` by default (verified: header value appears as `REDACTED`). | **Caddy logs the full request URI including query strings.** Never put a token, code or secret in a query string. The API does not accept credentials that way. |
| 18 | **Supply-chain compromise of build dependencies** | `pnpm install --frozen-lockfile` in both CI and the Docker build, `onlyBuiltDependencies` restricted to `esbuild`, production image contains no toolchain and runs as an unprivileged user (`skymatrix`). | The npm registry itself is trusted; pin image digests if that is not acceptable. |
| 19 | **Unauthorised administrative surface exposure** | Only Caddy publishes ports; MongoDB, Redis and the auth server are on the internal Docker network. `/docs` (Swagger UI) is blocked at the edge (`respond @docs 404`). | Anyone on the host's Docker network can reach the app directly. Treat host access as root-equivalent. |

## Local verification by other services

`GET /api/v1/auth/jwks` exists so other Skymatrix services can verify access tokens **offline**
(`jose`, `jsonwebtoken`, etc.) without a network call per request. What that buys and what it costs:

| | Pros | Cons |
| --- | --- | --- |
| Offline JWKS verification | No latency, no coupling, works if the auth server is briefly down | **No revocation or ban visibility**: the token stays "valid" until `exp` (≤ 900 s) |
| Call `/api/v1/users/me` (or admin introspection) | Live ban/session/permission state | Extra hop, and the auth server becomes a hard dependency |

Recommended pattern: verify signatures locally for cheap reads, and either keep access tokens short or
call this API for anything that must reflect a ban immediately (writes, money, server join). A service
that only verifies `sid` locally is accepting a token that may already be revoked — this is the
documented residual risk in row 7.

## What is never stored, never logged, never accepted

| Secret | Where it may live | Where it must never appear |
| --- | --- | --- |
| Mojang access token | Client only | Anywhere in this system — the API has no field for it |
| Shared secret (16 B AES) | Request body in memory, hashed into `serverId'` | MongoDB, Redis, logs, audit metadata |
| Verify token (4 B) | Challenge record in Redis (base64) | Logs, audit metadata |
| Refresh token (plaintext) | Client only | MongoDB (only SHA-256 hash), Redis, logs |
| Access token | Client, `Authorization` header | Logs, query strings, audit metadata |
| JWT / Minecraft private keys | Env PEM (preferred) or `service_keys` | Logs, audit metadata, API responses |

## Hardening checklist for operators

- [ ] Long random `MONGO_INITDB_ROOT_PASSWORD` and `REDIS_PASSWORD`, URL-safe characters (see
      [deployment.md](deployment.md#secrets)).
- [ ] Inject the four PEM variables from a secret manager; keep the private keys out of MongoDB.
- [ ] Keep `CORS_ORIGINS` empty unless a browser client genuinely needs it.
- [ ] Keep `ACCESS_TOKEN_TTL_SECONDS` ≤ 900 and `REFRESH_TOKEN_TTL_DAYS` as short as UX allows.
- [ ] Restrict host SSH access; only Caddy publishes ports.
- [ ] Ship Caddy + auth-server logs off-host; alert on `auth.refresh.reused`, `auth.challenge.rejected`
      spikes, and `RATE_LIMITED` floods.
- [ ] Review `admin:users` grants regularly (`GET /api/v1/admin/users?query=…` plus `permissions`).
- [ ] Rotate keys deliberately (see [deployment.md](deployment.md#key-rotation)); treat rotation as a
      forced re-login event.
