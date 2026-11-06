# IRC server — REST API

The IRC server exposes a small REST surface next to the SRP v1 WebSocket: group
management, filter rules, presence and health probes. Everything here is
implemented in `apps/irc-server/src/modules/{groups,filters,presence,health}/routes.ts`
and mounted by `src/app.ts`.

- Protocol (WebSocket) reference: [srp-v1.md](./srp-v1.md)
- Deployment, TLS and the public hostname: [irc-deployment.md](./irc-deployment.md)
- Storage and indexes: [irc-database.md](./irc-database.md)

Base URL in a single-host deployment: `https://irc.example.com` (Caddy → `irc-server:3001`).
Internally the service listens on `http://irc-server:3001` and publishes no host port.

---

## 1. Authentication

Every `/v1/*` endpoint requires the auth server's access token:

```http
GET /v1/presence/me HTTP/1.1
Authorization: Bearer eyJhbGciOiJFZERTQSIs…
```

`requireAuth` runs the **same verification as the WebSocket upgrade**
(`src/http/require-auth.ts` → `src/infrastructure/auth/verify-token.ts`):

1. Ed25519 signature against the auth server's JWKS (`AUTH_JWKS_URL`);
2. `iss` = `JWT_ISSUER`, `aud` = `JWT_AUDIENCE`, `exp` enforced;
3. `scope` contains **`skymatrix:ircserver`** — a profile-only token cannot call
   this API either;
4. the session is not revoked: Redis key `auth:session:revoked:{sid}` must be absent.

Failures:

| Situation | HTTP | Body |
| --- | --- | --- |
| missing/non-Bearer header | 401 | `{"error":{"code":"UNAUTHORIZED","message":"Authorization: Bearer <token> is required"}}` |
| invalid/forged token | 401 | `{"error":{"code":"UNAUTHORIZED",…}}` |
| expired token | 401 | `{"error":{"code":"TOKEN_EXPIRED",…}}` |
| missing `skymatrix:ircserver` | 403 | `{"error":{"code":"SCOPE_DENIED",…}}` |
| revoked session | 403 | `{"error":{"code":"SESSION_REVOKED",…}}` |
| Redis unavailable (revocation uncheckable) | 401 | `{"error":{"code":"UNAUTHORIZED",…}}` — fail closed |

The authenticated identity always comes from the token (`sub`, `minecraft_uuid`,
`sid`), never from a path/body/query value. Group membership and filter
ownership are evaluated against the token's `minecraft_uuid`.

There is **no CORS middleware** in v1: the API is intended for server-side callers
and the mod client. `CORS_ORIGINS` is parsed into config but not wired up.

---

## 2. Error envelope

Every deliberate error — including 404 and validation failures — uses one shape:

```json
{ "error": { "code": "INVALID_REQUEST", "message": "maxMembers must be greater than or equal to 2" } }
```

| `error.code` | HTTP | Raised when |
| --- | --- | --- |
| `UNAUTHORIZED` | 401 | no/invalid token |
| `FORBIDDEN` | 403 | the caller is known but not allowed (admin-only endpoint, or a group role check such as "only the owner may delete") |
| `NOT_FOUND` | 404 | unknown route, unknown session/member id |
| `INVALID_REQUEST` | 400 | schema validation failure (body, params, query), including `role: "OWNER"` |
| `RATE_LIMITED` | 429 | group-creation quota exhausted (with a `Retry-After` header) |
| `GROUP_NOT_FOUND` | 404 | group does not exist, or the caller is not a member (GET path — deliberately indistinguishable) |
| `GROUP_ACCESS_DENIED` | 403 | caller is not a member on a mutating path that first requires membership |
| `CONFLICT` | 409 | conflicting state (a full group) |
| `PAYLOAD_TOO_LARGE` | 413 | request body over the limit (Fastify `bodyLimit` 128 KiB) |
| `INTERNAL` | 500 | unexpected server fault (details are not leaked) |

Unknown routes return `404` with `{"error":{"code":"NOT_FOUND","message":"Route GET /nope not found"}}`.

### Validation happens before authentication

Fastify validates the body/params schema before the `preHandler` auth hook runs.
Practically: an **unauthenticated** `POST`/`PUT`/`PATCH` with a malformed body
gets `400 INVALID_REQUEST`; with a well-formed body it gets `401 UNAUTHORIZED`.
`GET`/`DELETE` always report `401` first because they carry no body to validate.
A client that wants a clean 401 should send a valid body (or retry with a token).

---

## 3. Health and metrics

The two health probes require no authentication — they are what a load balancer
and the container healthcheck use. `/metrics` is administrative and needs a
bearer token from an `ADMIN_UUIDS` identity.

### `GET /health/live`

```json
{ "status": "ok", "uptimeSeconds": 42 }
```

Never touches MongoDB or Redis: a live process is a live process.

### `GET /health/ready`

```json
{ "status": "ok", "checks": { "mongo": "ok", "redis": "ok" }, "connections": 17 }
```

- `200` when both dependencies answer, `503` with the same shape and
  `status: "degraded"` when either does not.
- `connections` is the number of live sockets on **this node**.
- This is the compose healthcheck target.

### `GET /metrics`

Minimal operational counters, no per-user data and no payloads:

```json
{ "connections": 17, "uptimeSeconds": 42 }
```

It is an internal endpoint: it requires an administrator token
(`ADMIN_UUIDS`) and is **not** proxied by the Caddy IRC site, so it is only
reachable from inside the Docker network (for example from a sidecar or
`docker exec`).

---

## 4. Presence

Presence is privacy-sensitive: a player may always read their own state, and
another player's state only when they share a group (or the caller is an
administrator UUID). There is deliberately no "list everyone online" endpoint.

### `GET /v1/presence/me`

```bash
curl -sS https://irc.example.com/v1/presence/me -H "Authorization: Bearer $TOKEN"
```

```json
{ "online": true, "connections": 1, "instanceId": "irc-01" }
```

`connections` counts this player's presence records, which is the number of live
sockets they hold (up to `MAX_CONNECTIONS_PER_USER`).

### `GET /v1/presence/:uuid`

```bash
curl -sS https://irc.example.com/v1/presence/069a79f4-44e9-4726-a5be-fca90e38aaf5 \
  -H "Authorization: Bearer $TOKEN"
```

```json
{ "minecraftUuid": "069a79f4-44e9-4726-a5be-fca90e38aaf5", "online": false, "connections": 0 }
```

| Case | Result |
| --- | --- |
| the caller's own UUID | always allowed |
| shares a group with the target | allowed |
| administrator UUID (`ADMIN_UUIDS`) | allowed |
| otherwise | `403 FORBIDDEN` |
| malformed UUID | `400 INVALID_REQUEST` |

---

## 5. Groups

A group is an opaque id (`grp_` + 16 URL-safe random characters), a display name,
an owner UUID and a member list. Duplicate display names are allowed — the id is
the identity. Groups are soft-deleted in storage (`status: DELETED`) but a
deleted group behaves exactly like a missing one over the API.

### Roles

| Action | OWNER | ADMIN | MEMBER |
| --- | :---: | :---: | :---: |
| view group and members | ✓ | ✓ | ✓ |
| send a GROUP message | ✓ | ✓ | ✓ |
| edit name / visibility / member cap | ✓ | ✓ | — |
| invite and remove members | ✓ | ✓ | — |
| edit group filter rules | ✓ | ✓ | — |
| promote / demote a member | ✓ | — | — |
| delete the group | ✓ | — | — |

- Ownership is not transferable in v1: a group always has exactly one OWNER, and
  the owner cannot leave (they delete the group instead).
- Only the owner may create an ADMIN; an ADMIN may only invite MEMBERs. Nobody
  can assign OWNER.

### `POST /v1/groups`

```bash
curl -sS -X POST https://irc.example.com/v1/groups \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Builders","visibility":"PRIVATE","maxMembers":20}'
```

`201 Created`

```json
{
  "group": {
    "id": "grp_3Tq0m9Yc1sV2bN7x",
    "name": "Builders",
    "ownerUuid": "069a79f4-44e9-4726-a5be-fca90e38aaf5",
    "visibility": "PRIVATE",
    "maxMembers": 20,
    "status": "ACTIVE",
    "createdAt": "2026-11-06T15:10:02.114Z",
    "updatedAt": "2026-11-06T15:10:02.114Z"
  }
}
```

| Body field | Rules |
| --- | --- |
| `name` | 1–64 chars, required |
| `visibility` | `PRIVATE` (default) or `PUBLIC` |
| `maxMembers` | integer ≥ 2, capped at `MAX_GROUP_MEMBERS` (default 100); defaults to the cap |

The group is created PRIVATE first and switched to PUBLIC in a second
owner-authorised step, so a failed creation can never leave a public group behind.

**Creation quota.** Each player may create `CREATE_GROUP_PER_HOUR` groups per hour
(default 5). The counter is a Redis fixed window per caller per clock hour
(`irc:ratelimit:creategroup:{uuid}:{window}`, INCR + PEXPIRE in one MULTI). Over
the limit the route answers `429 RATE_LIMITED` with a `retry-after` header and a
message that names the limit. The limiter **fails open**: if Redis is unavailable
the creation is allowed and a warning is logged — this is an anti-abuse limit, not
a security gate.

### `GET /v1/groups`

The caller's groups, newest first. `200 {"groups":[…]}`.

### `GET /v1/groups/:id`

`200 {"group":{…}}`, or `404 GROUP_NOT_FOUND` when the caller is not a member —
membership is not revealed by a different status.

### `PATCH /v1/groups/:id`

OWNER/ADMIN. Body: any of `name`, `visibility`, `maxMembers` (at least one, else
`400`). `200 {"group":{…}}`.
A plain MEMBER gets `403 FORBIDDEN` ("Only group owners and admins may edit a
group"); a non-member gets `403 GROUP_ACCESS_DENIED`; lowering `maxMembers` below
the current member count is `400 INVALID_REQUEST`.

### `DELETE /v1/groups/:id`

OWNER only. `204 No Content`; memberships are removed, the document is soft-deleted.

### `POST /v1/groups/:id/members`

```bash
curl -sS -X POST https://irc.example.com/v1/groups/grp_3Tq0m9Yc1sV2bN7x/members \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"userUuid":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","role":"MEMBER"}'
```

`201 Created`

```json
{ "member": { "groupId": "grp_3Tq0m9Yc1sV2bN7x", "userUuid": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", "role": "MEMBER", "joinedAt": "2026-11-06T15:12:44.001Z" } }
```

`userUuid` accepts dashed or bare hex and is canonicalised to lowercase dashed.
`role` is optional (`ADMIN` or `MEMBER`; OWNER is not assignable — sending it is a
`400 INVALID_REQUEST`) and defaults to `MEMBER`.

Adding a player who is already a member is **idempotent**: the existing membership
is returned with `201`, no duplicate row is written. A full group is a
`409 CONFLICT` (`Group is full (N members)`).

### `PATCH /v1/groups/:id/members/:uuid`

OWNER only, body `{"role":"ADMIN"|"MEMBER"}`. Cannot change your own role and
cannot assign OWNER (both `403`). `200 {"member":{…}}`.

### `DELETE /v1/groups/:id/members/:uuid`

Removes a member — or, when `:uuid` is the caller, leaves the group. `204 No Content`.
An ADMIN may remove only MEMBERs; the OWNER cannot leave (`403 FORBIDDEN`), they
delete the group instead. Removing somebody who is not a member is
`404 NOT_FOUND`.

---

## 6. Filters

Filter rules decide which message **types** a scope accepts. Patterns are
deliberately simple (`chat.message`, `chat.*`, `*`) — see
[srp-v1.md §8](./srp-v1.md#8-type-names-and-filter-patterns).

Three scopes:

| Scope | Read | Replace | Meaning |
| --- | --- | --- | --- |
| `USER` | `GET /v1/filters/me` | `PUT /v1/filters/me` | rules applied to messages addressed **to the caller** |
| `GROUP` | `GET /v1/groups/:id/filters` (any member) | `PUT /v1/groups/:id/filters` (OWNER/ADMIN) | rules applied to messages routed to that group |
| `GLOBAL` | `GET /v1/admin/filters/global` | `PUT /v1/admin/filters/global` | rules applied to **every** message; requires an `ADMIN_UUIDS` identity |

Rules are always replaced as a **set** — `PUT` is idempotent and omitting a rule
is how you delete it. At most 100 rules per scope (`MAX_RULES_PER_SCOPE`); a
`DENY` rule wins over an `ALLOW` rule for the same type.

### `GET /v1/filters/me`

```json
{ "rules": [ { "id": "…", "scope": "USER", "targetId": "069a79f4-…", "pattern": "chat.*", "action": "DENY", "enabled": true, "createdAt": "2026-11-06T15:20:00.000Z" } ] }
```

### `PUT /v1/filters/me`

```bash
curl -sS -X PUT https://irc.example.com/v1/filters/me \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"rules":[{"pattern":"chat.*","action":"DENY"},{"pattern":"server.alert","action":"ALLOW"}]}'
```

`200 {"rules":[…]}` with the stored set. Invalid patterns (`chat*`, `**`,
`a..b`, >128 chars) → `400 INVALID_REQUEST`.

### Group and global rules

Identical body and response shapes:

| Route | Who |
| --- | --- |
| `GET /v1/groups/:id/filters` | any member of the group |
| `PUT /v1/groups/:id/filters` | group OWNER/ADMIN |
| `GET /v1/admin/filters/global` | `ADMIN_UUIDS` identity (`403 FORBIDDEN` otherwise) |
| `PUT /v1/admin/filters/global` | `ADMIN_UUIDS` identity |

Every successful rule replacement writes an audit record
`filter.rules.updated` (`{scope, ruleCount}` — identifiers only, never rule
content or message data).

---

## 7. Audit

There is **no REST endpoint for the audit log** in the IRC server: audit records
are written to MongoDB (`irc_audit_logs`) for security review and are read
out-of-band (direct query, or the auth platform's admin tooling). This keeps the
IRC API from becoming a read oracle over other players' activity.

Events written by the IRC server:

| Event | When |
| --- | --- |
| `group.created` / `group.updated` / `group.deleted` | group lifecycle |
| `group.member.joined` / `group.member.left` / `group.member.removed` / `group.member.role_changed` | membership changes |
| `filter.rules.updated` | any scope's rules replaced |
| `irc.message.type_denied` | a message was refused by the global filter |
| `irc.broadcast.sent` | a broadcast was delivered (recipients count, message id) |

Every record carries the actor UUID, target type/id, client IP (from the trusted
`X-Forwarded-For` hop) and bounded `metadata`. Payloads are never recorded.

---

## 8. OpenAPI

The IRC service does **not** expose an OpenAPI document or a `/docs` UI (§
`app.ts` registers no swagger plugin). The route schemas are declared for
validation and serialisation only. The authoritative interface is this document
plus `src/modules/*/routes.ts`.

---

## 9. Known gaps (v1)

Documented so nobody assumes a protection that is not there:

- Only group creation has a REST rate limit (`CREATE_GROUP_PER_HOUR`); the other
  REST endpoints have no request rate limiter of their own. The `RATE_LIMITED`
  code exists for both paths. The WebSocket path **is** rate-limited per
  connection.
- `CORS_ORIGINS` is parsed but no CORS middleware is registered.
- Presence reads another player's state only via group co-membership; there is no
  bulk presence snapshot.
