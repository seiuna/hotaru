# Local login bridge (browser ⇄ Minecraft mod)

The admin console cannot perform the Minecraft handshake itself: there is no way for a web page to
obtain a Minecraft access token. The bridge moves that step into the game.

```
┌─────────────┐   1. GET /v1/health          ┌──────────────────────────┐
│  browser    │──────────────────────────────►│  Minecraft (Fabric mod)  │
│  (console)  │   2. OPTIONS preflight        │  127.0.0.1:8765          │
│             │   3. POST /v1/login           │  LocalAuthBridge         │
└─────────────┘                               └───────────┬──────────────┘
                                                          │ 4. in-game prompt
                                                          │    "allow this site?"
                                                          ▼
                                              McAuthClient ──► auth-server ──► Mojang
                                                          │
        ◄──────────── 5. { accessToken, refreshToken, profile, scopes } ────────┘
```

Everything stays loopback: the browser talks to `127.0.0.1`, the mod talks to the auth server, and the
Mojang access token never leaves the game process except to Mojang.

## Why a loopback server and not a custom URL scheme

A registered URL scheme (`skymatrix://`) can also hand data to a page, but it cannot answer "is the mod
running?", cannot report *why* a login failed, and on several platforms pops an OS dialog every time.
A loopback endpoint is the pattern desktop OAuth clients use: explicit origin allowlist, explicit user
consent, immediate error reporting.

## Protocol

Base: `http://127.0.0.1:8765` (`DEFAULT_BRIDGE_PORT`; configurable on both sides).

### `GET /v1/health`

No token, no side effects. Used by the login page to decide whether to show the button as available.

```json
{ "ok": true, "service": "skymatrix-local-auth", "version": "0.1.0", "port": 8765, "requiresApproval": true }
```

### `POST /v1/login`

Requires an `Origin` header on the allowlist. Blocks while the player answers the in-game prompt.

```json
{
  "accessToken": "eyJhbGciOiJFZERTQSIs...",
  "refreshToken": "…",
  "tokenType": "Bearer",
  "expiresIn": 900,
  "profile": { "uuid": "4c1099df-e202-4e64-9ea2-9039be420143", "username": "yuuiyi" },
  "scopes": ["skymatrix:profile", "admin:users"]
}
```

Errors (HTTP status + machine-readable code):

| Status | `error.code` | Meaning |
| --- | --- | --- |
| 403 | `ORIGIN_REQUIRED` | No `Origin` header — not a browser call |
| 403 | `ORIGIN_NOT_ALLOWED` | Origin is not on the mod's allowlist |
| 403 | `APPROVAL_DENIED` | The player refused in game |
| 403 | `HOST_NOT_ALLOWED` | `Host` header is not loopback (DNS-rebinding attempt) |
| 408 | `APPROVAL_TIMEOUT` | Nobody answered the prompt in time |
| 429 | `RATE_LIMITED` | More than 5 logins/minute from that origin (`Retry-After: 60`) |
| 500 | `MINT_FAILED` | The game could not finish the Mojang handshake (expired session, Mojang down) |

### `OPTIONS *` (CORS preflight)

Answered only for allowlisted origins, with `Access-Control-Allow-Origin: <exact origin>`,
`Access-Control-Allow-Methods: GET, POST, OPTIONS`, and — for Chromium's Private Network Access —
`Access-Control-Allow-Private-Network: true`.

## Security model

| Threat | Mitigation |
| --- | --- |
| A random website silently harvesting a token | Every login needs a fresh in-game approval; the origin must be pre-allowlisted; no wildcard CORS |
| Malicious page on the LAN reaching the bridge | Binds `127.0.0.1` only; `BridgeConfig` rejects any other bind address |
| DNS rebinding (`evil.example` → 127.0.0.1) | `Host` header must be `127.0.0.1`, `localhost` or `::1` |
| Replay of the bridge response | Responses are `Cache-Control: no-store`; tokens are short-lived and session-bound |
| Prompt spam / handshake flooding | Fixed window of 5 logins/minute per origin, plus the auth server's own rate limits |
| Token leaking through logs | `TokenResponse.toString()` is redacted; the bridge never logs token values |
| A malicious local process | Out of scope for any loopback bridge — same trust boundary as the game itself |

The bridge is **ephemeral**: start it when the client starts, close it on exit or logout. It holds no
state and stores nothing on disk.

## Wiring it into a Fabric mod

`clients/fabric-sdk-java/fabric-example/SkymatrixAuthBridgeExample.java.example` shows the full
`ClientModInitializer` wiring. Two rules:

1. `BridgeConfig.allowedOrigins` must be an exact list. Never `*`.
2. `ApprovalGate` must ask the player (a confirmation screen). Returning `true` without asking turns the
   bridge into a token vending machine for any allowlisted page — and allowlists are easy to get wrong.

```java
bridge = LocalAuthBridge.start(
    new BridgeConfig("127.0.0.1", 8765, Set.of("https://admin.example.com"),
                     Duration.ofSeconds(60), 5, true),
    () -> authClient.authenticate(session),
    new ScreenApprovalGate(minecraftClient));
```

## Browser side

`apps/admin-web/src/services/localBridge.ts` implements the client half:

- probes `/v1/health` on mount (1.5 s budget) so the button reflects reality;
- `POST /v1/login` with a 65 s budget for the in-game confirmation;
- maps `ORIGIN_NOT_ALLOWED` → "把这个站点加入模组允许来源", `APPROVAL_DENIED` → "你已在游戏内拒绝",
  unreachable port → "未检测到本地认证服务…", browser-blocked request → "请允许本站访问本地网络";
- hands the token straight to the auth store (`sessionStorage`); it is never logged or put in a URL.

Chromium ≥ 115 shows a one-time "允许此站点访问本地网络设备" permission for public pages reaching
`127.0.0.1`. Safari requires the same kind of approval. If the fetch rejects without a response, the
console says so instead of pretending the mod is missing.

## Local end-to-end check (no Minecraft needed)

```bash
cd clients/fabric-sdk-java && javac -d out "@sources.txt"
node tools/e2e/bridge-login.mjs
```

`BridgeDemo` stands in for the mod: it reads the player's session from `TEST_ACCESSTOKEN`, auto-approves
(loudly — a real mod must ask), and serves the same bridge. The script then behaves exactly like
Chrome: preflight, login, use the JWT against the real API, and confirm a foreign origin is refused.
Last run: **17/17 checks passed** (mint took ~2.6 s including the real Mojang join/hasJoined).

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Button says "未检测到本地认证服务" | Game not running, mod not installed, or another process owns 8765 |
| "本地 Mod 未授权当前站点" | Console origin missing from `allowedOrigins` (note: scheme + port must match exactly) |
| "浏览器阻止了访问本地端口的请求" | Private Network Access permission denied, or a browser without PNA support |
| "游戏内确认超时" | Player did not answer within 60 s |
| `MINT_FAILED` | The Minecraft session expired — restart the game and retry |
