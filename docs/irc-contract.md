# IRC server (SRP v1) — build contract

Read this before writing code under `apps/irc-server` or `packages/srp-protocol`. It pins the interfaces,
conventions and local infrastructure so the core and the feature modules can be built in parallel.

## Layout and ownership

| Area | Path | Owner |
| --- | --- | --- |
| Protocol contract (envelope, ops, error codes, limits, matcher) | `packages/srp-protocol/**` | Lead |
| Boot, config, HTTP app, WS attach/auth, connection registry, presence, dispatcher, rate limit, dedupe, DIRECT/GROUP/BROADCAST routing, health | `apps/irc-server/src/{server.ts,app.ts,context.ts,config/**,http/**,ws/**,runtime/**,modules/{protocol,health,routing,presence,connections}/**}` | Lead |
| Groups, filters, audit (models + services + REST) | `apps/irc-server/src/modules/{groups,filters,audit}/**` | irc-groups |
| e2e harness, deploy, protocol docs | `tools/e2e/irc/**`, `deploy/**`, `docs/{srp-v1,irc-api,irc-database,irc-security,irc-deployment}.md` | irc-verify |

**Do not edit another owner's files.** `package.json` is Lead-owned; ask instead of adding dependencies.

## Runtime shape

```ts
// src/context.ts
interface AppContext {
  config: AppConfig;      // parsed env (src/config/env.ts)
  redis: Redis;           // ioredis, shared with the auth server
  instanceId: string;     // this node's id for presence/pubsub
  now: () => number;      // injectable clock
}
```

## Auth for REST routes

`requireAuth` (`src/http/require-auth.ts`) verifies the same Ed25519 JWT the WebSocket upgrade uses and
sets:

```ts
request.auth = { userId, minecraftUuid, sessionId, scopes }
```

Rules: signature via the auth server's JWKS, `iss`/`aud` checked, `exp` enforced, the Redis key
`auth:session:revoked:{sid}` must be absent, and `skymatrix:ircserver` must be in `scope`.

## Errors

- REST: `throw new AppError(code, message, status)` from `src/http/app-error.ts`; the global handler
  returns `{ error: { code, message } }`.
- WebSocket: never throw at the socket; send an `ERROR` frame with a code from
  `@skymatrix/srp-protocol` and keep the connection open unless the protocol is violated.

## Message lifecycle (core)

1. Upgrade → verify JWT → capacity checks (per user / per IP / total) → accept → send `READY`.
2. Incoming frame → size check (`config.maxFrameBytes`) → JSON parse → `clientFrameSchema` parse.
3. `MESSAGE` → validate type (`validateTypeName`) → global deny filter → route:
   - DIRECT: target must be online → per-recipient deny filter → deliver → `ACK delivered` or
     `ACK failed` with `TARGET_OFFLINE`.
   - GROUP: membership + group deny filter → deliver to online members except the sender's own socket →
     `ACK delivered` with `recipients`.
   - BROADCAST: requires `skymatrix:irc:broadcast` (or an admin UUID) → global + per-recipient deny →
     deliver.
4. TTL: `expireAt = receivedAt + ttlMs` (server clock). If `now > expireAt` at delivery time →
   `MESSAGE_EXPIRED`.
5. Dedupe: Redis `SET NX EX` on `irc:dedupe:{senderUserId}:{messageId}`; a duplicate with the same
   payload returns the previous ACK result, a duplicate with a different payload returns
   `DUPLICATE_MESSAGE_ID`.
6. Rate limits: token bucket per connection (`config.messageRatePerSec`, `config.messageBurst`) and a
   stricter group bucket; exceeded → `ERROR RATE_LIMITED` + `ACK failed`.
7. Slow clients: `ws.bufferedAmount > config.maxWsBufferedBytes` → close with a reason, log backpressure.

## Presence (Redis)

```
irc:presence:conn:{connectionId}   JSON { connectionId, userId, minecraftUuid, instanceId, connectedAt, lastHeartbeat } TTL=config.presenceTtlMs
irc:presence:user:{minecraftUuid}  SET of connectionIds
irc:presence:instance:{instanceId} SET of connectionIds
```

A user is online iff at least one of their connection records still exists. Never treat a set member as
alive without its connection record (TTL is the safety net, not the source of truth).

## Local infrastructure

```
MongoDB   mongodb://127.0.0.1:27017   (container skymatrix-mongo)  DBs: skymatrix_irc / skymatrix_irc_test
Redis     redis://127.0.0.1:16379     (container skymatrix-redis)  shared with the auth server
auth      http://127.0.0.1:3000       (JWKS at /api/v1/auth/jwks)
IRC       http://127.0.0.1:3001       (WS at /v1/connect)
```

Port 6379 cannot be bound on this host (Docker Desktop proxy), hence 16379. Do not "fix" it.

## Conventions

- ESM + NodeNext → relative imports need `.js`.
- Strict TS: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`.
- **Never trust the client**: sender identity comes from the JWT, never from the payload; roles come from
  MongoDB; scopes come from the verified token; time comes from the server.
- **Never log payloads** or tokens. Audit entries record identifiers and decisions only.
- Every limit in `config` exists for a reason — enforce it at the boundary, not deep in the fan-out.
- Tests: unit next to source (`*.test.ts`, run by `pnpm --filter @skymatrix/irc-server test`);
  integration in `tests/integration/` (`pnpm --filter @skymatrix/irc-server test:integration`).

## Definition of done

`pnpm --filter @skymatrix/irc-server typecheck`, `lint` and `test` pass for your scope, and the feature
works through the real transport (WS frame or HTTP request), not just unit-level.
