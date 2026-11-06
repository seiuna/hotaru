# Internal development contract — MC Auth Platform

Read this before writing code in `apps/auth-server`. It lists what already exists, what you own, and
the exact interfaces to code against. Anything not listed here is someone else's scope.

## Ownership map

| Area | Path | Owner |
| --- | --- | --- |
| Foundation (config, errors, models, crypto, Mongo/Redis, Mojang client, auth plugin, app wiring) | `src/config`, `src/errors.ts`, `src/context.ts`, `src/infrastructure/**`, `src/plugins/**`, `src/app.ts`, `src/server.ts` | Lead |
| Audit service + health routes | `src/modules/audit`, `src/modules/health` | Lead |
| Minecraft challenge/verify + token issuance/refresh/logout (`/api/v1/auth/*`) | `src/modules/minecraft-auth/**`, `src/modules/tokens/**` | auth-core |
| Users + admin API + seed script | `src/modules/users/**`, `src/modules/admin/**`, `scripts/seed-admin.ts` | users-admin |
| Fabric Java SDK | `clients/fabric-sdk-java/**` | java-sdk |
| Deploy, docs, OpenAPI export | `deploy/**`, `docs/**`, `.env.example`, `README.md`, `scripts/export-openapi.ts` | deploy-docs |

**Do not edit `package.json` files.** The Lead owns dependencies and installs. If you need one, message
the Lead instead of adding it.

**Stay inside your scope.** If you need a change in foundation code, message the Lead with the exact
file and why — do not edit it yourself; parallel edits to the same file lose work.

## Runtime shape

```ts
// src/context.ts
interface AppContext {
  config: AppConfig;          // parsed + validated env (see src/config/env.ts)
  keys: ServiceKeys;          // Ed25519 JWT pair + RSA Minecraft pair
  redis: Redis;               // ioredis instance, ready to use
}
```

`buildApp(ctx)` decorates `app.ctx`, so inside a route you have `request.server.ctx`. Route modules are
plain async functions:

```ts
export async function registerXxxRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post('/api/v1/...', { schema, preHandler }, handler);
}
```

## Existing foundation you must reuse

### Errors — `src/errors.ts`

Throw `AppError` from `Errors.*`; the global handler formats `{ error: { code, message, retryable, details? } }`.
Never hand-build an error body. Available: `invalidRequest`, `challengeNotFound`, `challengeExpired`,
`challengeConsumed`, `notPremiumSession`, `mojangUnavailable`, `rateLimited`, `unauthorized`,
`tokenExpired`, `sessionRevoked`, `refreshReused`, `userBanned`, `forbidden`, `notFound`, `internal`.

### Auth guard — `src/plugins/auth.ts`

```ts
app.get('/api/v1/users/me', { preHandler: authenticate() }, handler);            // any valid JWT
app.put('/api/v1/admin/users/:id/permissions',
  { preHandler: authenticate({ scopes: ['admin:users'] }) }, handler);          // scope-guarded
```

The guard verifies signature/issuer/audience/expiry, checks the Redis revocation key, reloads the
session and user from MongoDB, and recomputes scopes **from the database**. Handlers read
`request.auth!` → `{ userId, minecraftUuid, username, sessionId, jti, scopes }`.

### Mongo models — `src/infrastructure/mongo/models/index.ts`

`UserModel`, `PermissionModel`, `AdminModel`, `SessionModel`, `RefreshTokenModel`, `AuditLogModel`,
`LicenseModel`, `ServiceKeyModel`. Key fields:

- User: `minecraftUuid` (unique), `username`, `status` (`active|banned`), `banReason`, `bannedAt`, `lastLoginAt`, timestamps.
- Permission: `userId`, `scope`, `expiresAt` (`null` = permanent), `grantedBy`, unique index `(userId, scope)`.
- Session: `userId`, `expiresAt`, `revokedAt`, `revokedReason`, `ip`, `userAgent`, timestamps.
- RefreshToken: `sessionId`, `userId`, `tokenHash` (unique), `expiresAt`, `usedAt`, `replacedByHash`, `revokedAt`.
- AuditLog: `event`, `actorId`, `actorType`, `targetType`, `targetId`, `ip`, `metadata`, `createdAt`.
- Admin: `identity` (Mojang UUID, unique), `role` (`owner|admin|support`), `createdBy`.

### Crypto — `src/infrastructure/crypto/`

- `minecraftServerHash(serverId, sharedSecret, publicKeyDer): string` — vanilla-compatible signed hex.
- `ctx.keys.minecraft.privateKey` (RSA-1024 `KeyObject`, decrypt with `RSA_PKCS1_PADDING`),
  `ctx.keys.minecraft.publicKeyBase64` / `.publicKeyDer` (the same DER bytes are hashed).
- `ctx.keys.jwt` → `{ privateKey, publicKey, kid, alg: 'EdDSA', publicJwk }`.

### Mojang — `src/infrastructure/mojang/client.ts`

```ts
hasJoined(config, { username, serverId, ip? }): Promise<{ uuid; username } | null>
```

`null` means Mojang said "no such session" (fail closed). It throws `MOJANG_UNAVAILABLE` (retryable)
on transport errors/5xx. It already retries a first 204 once or twice to absorb join propagation lag.

### Audit — `src/modules/audit/service.ts`

```ts
await recordAudit(ctx, { event, actorId?, actorType?, targetType?, targetId?, ip?, metadata? });
```

Fire-and-forget is fine (`void recordAudit(...)`) but never swallow a security-relevant event.

### Validation + docs — `src/http/zod-schema.ts`

```ts
import { toJsonSchema } from '../../http/zod-schema.js';
app.post('/path', { schema: { body: toJsonSchema(verifyRequestSchema), response: { 200: toJsonSchema(tokenResponseSchema) }, tags: ['auth'], summary: '...' } }, handler);
```

Parse request bodies with the matching Zod schema from `@skymatrix/api-contract` (`schema.parse(request.body)`).
A thrown `ZodError` is converted to `400 INVALID_REQUEST` by the global handler.

## Conventions

- **ESM + NodeNext**: relative imports need the `.js` extension (`./service.js` even though the file is `.ts`).
- **Strict TS**: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` are on.
  Use `import type` for types. No `any` — use `unknown` + narrowing.
- **Never trust client claims.** UUID, premium flag and scopes only ever come from Mojang or MongoDB.
- **Never log or store**: Minecraft access tokens, shared secrets, verify tokens, raw refresh tokens,
  RSA private keys.
- **Fail closed**: any uncertainty in authentication means no token.
- Rate limits and one-time challenge consumption must be atomic in Redis (Lua or `GETDEL`/`SET NX`).

## Redis key conventions (shared, keep them stable)

```
auth:challenge:{id}          string(JSON) TTL = config.challengeTtlSeconds
auth:rate:ip:{ip}            counter     TTL = config.rateLimitWindowSeconds
auth:rate:uuid:{uuid}        counter     TTL = config.rateLimitWindowSeconds
auth:session:revoked:{sid}   "1"         TTL until access-token expiry (revocation fast path)
```

## Wire format (pinned — client, server and e2e harness all follow this)

```
challenge.verifyToken   = base64(4 random raw bytes)   -> client RSA-encrypts the 4 RAW bytes
encryptedSharedSecret   = base64(RSA/PKCS#1 v1.5 ciphertext of 16 raw secret bytes)
encryptedVerifyToken    = base64(RSA/PKCS#1 v1.5 ciphertext of the 4 raw verify-token bytes)
serverId                = opaque ASCII (base64url of 16 random bytes), first hash input
serverHash              = sha1(serverId ASCII || sharedSecret || publicKeyDer) as SIGNED 160-bit hex
```

Username matching between challenge and verify is case-insensitive; identity always comes from Mojang.

## Local infrastructure (already running)

```
MongoDB   mongodb://127.0.0.1:27017    (container skymatrix-mongo)
Redis     redis://127.0.0.1:16379      (container skymatrix-redis — NOT 6379)
```

Port 6379 is unusable on this host: Docker Desktop's proxy silently fails to bind it, so the
container publishes 16379 instead. Do not "fix" this by restarting the container.

## Testing

- Unit tests live next to the code: `src/modules/.../x.test.ts`, run with `pnpm --filter @skymatrix/auth-server test`.
- Integration tests live in `tests/integration/*.integration.test.ts`, run with
  `pnpm --filter @skymatrix/auth-server test:integration` — they use the real containers:
  `MONGODB_URI=mongodb://127.0.0.1:27017`, `MONGODB_DB=skymatrix_auth_test`, `REDIS_URL=redis://127.0.0.1:16379`.
  They must clean up their own data (drop collections) and never depend on another test's state.
- Build the app for tests with `buildApp(ctx)` and drive it with `app.inject(...)` — no real ports.
- Prove the negative cases: expired challenge, consumed challenge, replayed refresh token,
  forged UUID, Mojang 5xx, missing scope.

## Definition of done

`pnpm typecheck`, `pnpm lint`, `pnpm test` pass for your package, plus your module's routes work end to
end through `app.inject`. Report: files written, what you ran, what you could not verify.
