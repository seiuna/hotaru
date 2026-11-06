# Local login bridge (browser 闁?Minecraft mod)

The admin console cannot perform the Minecraft handshake itself: there is no way for a web page to
obtain a Minecraft access token. The bridge moves that step into the game.

```
闁崇懓澶囬弨銏ゅ煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘?  1. GET /v1/health          闁崇懓澶囬弨銏ゅ煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩?闁? browser    闁崇懓鍊甸弨銏ゅ煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩㈢悰鈩冩暅  Minecraft (Fabric mod)  闁?闁? (console)  闁?  2. OPTIONS preflight        闁? 127.0.0.1:8765          闁?闁?            闁?  3. POST /v1/login           闁? LocalAuthBridge         闁?闁宠鏌￠弨銏ゅ煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘?                              闁宠鏌￠弨銏ゅ煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘椤戣姤鏁橀柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁?                                                          闁?4. in-game prompt
                                                          闁?   "allow this site?"
                                                          闁?                                              McAuthClient 闁冲厜鍋撻柍鍏夊亾闁?auth-server 闁冲厜鍋撻柍鍏夊亾闁?Mojang
                                                          闁?        闁崇厧瀚ч弨銏ゅ煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳ь剟鍩為埀顒勫煘閳?5. { accessToken, refreshToken, profile, scopes } 闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁冲厜鍋撻柍鍏夊亾闁?```

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
  "refreshToken": "闁?,
  "tokenType": "Bearer",
  "expiresIn": 900,
  "profile": { "uuid": "4c1099df-e202-4e64-9ea2-9039be420143", "username": "yuuiyi" },
  "scopes": ["skymatrix:profile", "admin:users"]
}
```

Errors (HTTP status + machine-readable code):

| Status | `error.code` | Meaning |
| --- | --- | --- |
| 403 | `ORIGIN_REQUIRED` | No `Origin` header 闁?not a browser call |
| 403 | `ORIGIN_NOT_ALLOWED` | Origin is not on the mod's allowlist |
| 403 | `APPROVAL_DENIED` | The player refused in game |
| 403 | `HOST_NOT_ALLOWED` | `Host` header is not loopback (DNS-rebinding attempt) |
| 408 | `APPROVAL_TIMEOUT` | Nobody answered the prompt in time |
| 429 | `RATE_LIMITED` | More than 5 logins/minute from that origin (`Retry-After: 60`) |
| 500 | `MINT_FAILED` | The game could not finish the Mojang handshake (expired session, Mojang down) |

### `OPTIONS *` (CORS preflight)

Answered only for allowlisted origins, with `Access-Control-Allow-Origin: <exact origin>`,
`Access-Control-Allow-Methods: GET, POST, OPTIONS`, and 闁?for Chromium's Private Network Access 闁?`Access-Control-Allow-Private-Network: true`.

## Security model

| Threat | Mitigation |
| --- | --- |
| A random website silently harvesting a token | Every login needs a fresh in-game approval; the origin must be pre-allowlisted; no wildcard CORS |
| Malicious page on the LAN reaching the bridge | Binds `127.0.0.1` only; `BridgeConfig` rejects any other bind address |
| DNS rebinding (`evil.example` 闁?127.0.0.1) | `Host` header must be `127.0.0.1`, `localhost` or `::1` |
| Replay of the bridge response | Responses are `Cache-Control: no-store`; tokens are short-lived and session-bound |
| Prompt spam / handshake flooding | Fixed window of 5 logins/minute per origin, plus the auth server's own rate limits |
| Token leaking through logs | `TokenResponse.toString()` is redacted; the bridge never logs token values |
| A malicious local process | Out of scope for any loopback bridge 闁?same trust boundary as the game itself |

The bridge is **ephemeral**: start it when the client starts, close it on exit or logout. It holds no
state and stores nothing on disk.

## Wiring it into a Fabric mod

`examples/fabric-mod/SkymatrixAuthBridgeExample.java.example` shows the full
`ClientModInitializer` wiring. Two rules:

The library is Minecraft-independent: it only needs something that answers `accessToken()`. A Fabric mod
supplies that from the launcher session; a CLI or launcher supplies it from its own store. Keep the
Minecraft-specific code in your mod, not in the library.

1. `BridgeConfig.allowedOrigins` must be an exact list. Never `*`.
2. `ApprovalGate` must ask the player (a confirmation screen). Returning `true` without asking turns the
   bridge into a token vending machine for any allowlisted page 闁?and allowlists are easy to get wrong.

```java
bridge = LocalAuthBridge.start(
    new BridgeConfig("127.0.0.1", 8765, Set.of("https://admin.example.com"),
                     Duration.ofSeconds(60), 5, true),
    () -> authClient.authenticate(tokenProvider),   // AccessTokenProvider: one method
    new ScreenApprovalGate(minecraftClient));
```

## Browser side

`apps/admin-web/src/services/localBridge.ts` implements the client half:

- probes `/v1/health` on mount (1.5 s budget) so the button reflects reality;
- `POST /v1/login` with a 65 s budget for the in-game confirmation;
- maps `ORIGIN_NOT_ALLOWED` 闁?"闁硅泛锕ㄧ换鏍ㄧ▔椤忓棛褰查柣鎰嚀婵偤宕楅妷未浣虹磼閸曨偄甯掗悹浣告啞濞奸潧鈹?, `APPROVAL_DENIED` 闁?"濞达絿濮撮崙锟犲捶閵婏妇鍩楅柟鏉戠箰閸炴挳骞忛幒鏃傚崪",
  unreachable port 闁?"闁哄牜浜濋ˉ鍛圭€ｎ亜鐓傞柡鍫墮濠€瀵告媼閵堝牏妲堥柡鍫濈Т婵喖鍨?, browser-blocked request 闁?"閻犲洤鍢查崢鎴犳媼閸涘﹥鎷辩紒鏃€鐟ㄩ鏍⒒椤旇姤鎷遍柛锔藉缂嶅绱?;
- hands the token straight to the auth store (`sessionStorage`); it is never logged or put in a URL.

Chromium 闁?115 shows a one-time "闁稿繋娴囬蹇擃潰閵堝洨褰查柣鎰攰椤旀牠姊婚鑺ユ嫳闁革附澹嗙紞澶岀磼濠婂棭鍟庡? permission for public pages reaching
`127.0.0.1`. Safari requires the same kind of approval. If the fetch rejects without a response, the
console says so instead of pretending the mod is missing.

## Local end-to-end check (no Minecraft needed)

```bash
cd clients/fabric-sdk-java && javac -d out "@sources.txt"
node tools/e2e/bridge-login.mjs
```

`BridgeDemo` stands in for the mod: it reads the player's session from `TEST_ACCESSTOKEN`, auto-approves
(loudly 闁?a real mod must ask), and serves the same bridge. The script then behaves exactly like
Chrome: preflight, login, use the JWT against the real API, and confirm a foreign origin is refused.
Last run: **17/17 checks passed** (mint took ~2.6 s including the real Mojang join/hasJoined).

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Button says "闁哄牜浜濋ˉ鍛圭€ｎ亜鐓傞柡鍫墮濠€瀵告媼閵堝牏妲堥柡鍫濈Т婵? | Game not running, mod not installed, or another process owns 8765 |
| "闁哄牜鍓欏﹢?Mod 闁哄牜浜濆鍧楀级閸愩劎绉奸柛鎾崇Ф閻濐垶鎮? | Console origin missing from `allowedOrigins` (note: scheme + port must match exactly) |
| "婵炴潙绻楅～宥夊闯閵娾晜鈻庢慨婵愭線缁紕鎷嬮崸妤侊紪闁哄牜鍓欏﹢瀵哥博椤栨艾缍撻柣銊ュ椤曨剙效? | Private Network Access permission denied, or a browser without PNA support |
| "婵炴挸鎲￠崹娆撳礃閸涱垪鈧鎷嬮妶鍫⑿㈤柡? | Player did not answer within 60 s |
| `MINT_FAILED` | The Minecraft session expired 闁?restart the game and retry |
