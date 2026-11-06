# Skymatrix Java SDK (Java 21)

Dependency-free **Java 21** SDK for Skymatrix, in one jar with two halves:

| Half | Package | What it does |
| --- | --- | --- |
| **Auth** | `cn.seiua.mcauth` | Minecraft premium handshake against Mojang → Ed25519 JWT + rotating refresh token; plus the loopback login bridge (`cn.seiua.mcauth.bridge`) that lets a browser log in through the running game |
| **Relay** | `cn.seiua.irc`, `cn.seiua.irc.rest` | SRP v1 real-time client (WebSocket) and the REST client for groups / presence / filters |

Everything below the auth section applies to the auth half; the relay half is documented
[below](#irc-client-srp-v1).

The library performs the Minecraft "join" handshake against Mojang, then exchanges the result with the
auth server for an Ed25519 JWT plus a rotating refresh token.

**No Minecraft dependency.** The library never imports Minecraft, Fabric, launcher or mod-loader
classes 鈥?it has nothing to do with how the game works. You provide one method that returns the
player's access token, and the library resolves the rest:

```java
AccessTokenProvider provider = () -> mySessionStore.accessToken();
TokenResponse tokens = client.authenticate(provider);   // UUID + username come from Mojang
```

If you already know the UUID and username, implement `SessionProvider` instead (it extends
`AccessTokenProvider`) and save one HTTPS round trip. Fabric is just one host 鈥?the example integration
lives in `examples/fabric-mod/` and is deliberately outside this build.

```
clients/skymatrix-sdk-java
|-- README.md
|-- build.gradle                        standalone / Fabric build snippet
`-- src/
    |-- main/java/com/skymatrix/mcauth/
    |   |-- AccessTokenProvider.java     the only interface a host must implement
    |   |-- SessionProvider.java         optional: token + uuid + username
    |   |-- MinecraftProfileResolver.java resolves identity from Mojang (token-only logins)
    |   |-- PlayerProfile.java           uuid + username reported by Mojang
    |   |-- McAuthClient.java            handshake, refresh, logout, timeouts
    |   |-- ChallengeResponse.java       challenge DTO
    |   |-- TokenResponse.java           token pair + profile + scopes
    |   |-- TokenProfile.java            uuid + username
    |   |-- McAuthException.java         HTTP status + error.code + retryable + details
    |   |-- ApiErrorCode.java            the server's stable error codes
    |   |-- MinecraftServerHash.java     the vanilla signed-hex server hash
    |   |-- HandshakeCrypto.java         SecureRandom secret + RSA/PKCS#1 v1.5 encryption
    |   |-- Main.java                    runnable demo (offline by default)
    |   `-- json/Json.java               hand-written JSON reader/writer (no Jackson/Gson)
    `-- test/java/com/skymatrix/mcauth/
        |-- ServerHashSelfTest.java      algorithm + crypto + JSON + error-map checks
        |-- EndToEndSelfTest.java        full flow against a local mock server
        |-- bridge/BridgeSelfTest.java   loopback bridge contract (CORS/PNA/approval/limits)
        `-- bridge/ProfileResolverSelfTest.java  token-only identity resolution
```

Target: **JDK 21** (`javac --release 21`). Nothing outside the JDK is required: no Jackson, Gson,
OkHttp, Guava or Apache Commons. The only non-`java.*` package used is `com.sun.net.httpserver`, which
ships with the JDK and is used by the local bridge and the test mocks.

---

## Quick start

```java
McAuthClient client = McAuthClient.builder("https://auth.skymatrix.example")
        .connectTimeout(Duration.ofSeconds(5))   // TCP connect
        .requestTimeout(Duration.ofSeconds(10))  // whole request
        .build();

// Run on a background thread: the call blocks on HTTP.

// 1. Token only 鈥?the library asks Mojang who the player is.
TokenResponse tokens = client.authenticate(() -> session.accessToken());

// 2. Identity already known 鈥?one fewer HTTPS call.
TokenResponse tokens = client.authenticate(mySessionProvider);

// 3. Fully explicit.
TokenResponse tokens = client.authenticate(accessToken, playerUuid, username);

System.out.println(tokens.profile().username());   // from Mojang, via the server
System.out.println(tokens.scopes());               // computed by the server from MongoDB
String header = tokens.authorizationHeader();     // "Bearer <jwt>"

// Later - no new Mojang join needed:
TokenResponse rotated = client.refresh(tokens.refreshToken());
// On logout:
client.logout(rotated.accessToken());
```

`McAuthClient` is immutable and thread-safe. It is meant to live for the whole session.

`client.resolveProfile(accessToken)` is also public: use it to answer "is this token still valid, and
whose is it?" without logging in.

---

## The authentication sequence

```
 Fabric client mod              Mojang sessionserver          MC Auth server
 ------------------              -------------------          ---------------
 1. POST /api/v1/auth/minecraft/challenge {username, client:"fabric"}
    <------------------------------------------- {challengeId, serverId,
                                                  publicKey (Base64 DER),
                                                  verifyToken (Base64, 4 bytes),
                                                  expiresIn}

 2. sharedSecret = 16 random bytes
    encryptedSharedSecret = RSA/PKCS#1 v1.5(publicKey, sharedSecret) -> Base64
    encryptedVerifyToken  = RSA/PKCS#1 v1.5(publicKey, verifyToken)  -> Base64
    serverHash = sha1(serverId ASCII || sharedSecret || publicKeyDer)
                 as a SIGNED 160-bit integer, lowercase hex

 3. POST https://sessionserver.mojang.com/session/minecraft/join
    {accessToken, selectedProfile: <uuid without dashes>, serverId: serverHash}
    <------------------------------------------- 204 No Content

                                                         4. GET /session/minecraft/hasJoined
                                                            ?username&serverId  (server-side)
                                                            <-- uuid + name, or 204

 5. POST /api/v1/auth/minecraft/verify
    {challengeId, username, encryptedSharedSecret, encryptedVerifyToken}
    <------------------------------------------- {accessToken, refreshToken, tokenType,
                                                  expiresIn, profile{uuid,username},
                                                  scopes[]}
```

The server only issues tokens after **its own** `hasJoined` call to Mojang succeeds, so a client can
never talk its way in by lying about a UUID.

### The server hash, exactly

The hash is *not* `sha1(...).toHex()`. It is the vanilla client's signed reinterpretation:

```
digest   = sha1(serverId.getBytes(US_ASCII) || sharedSecret || publicKeyDer)   // 20 bytes
value    = digest reinterpreted as a signed 160-bit big-endian two's-complement integer
serverId = lowercase hex of value, '-' prefix when negative, no zero padding
```

Examples pinned by `ServerHashSelfTest` against the server's TypeScript implementation:

| SHA-1 digest (hex)                          | server hash                                |
| ------------------------------------------- | ------------------------------------------ |
| `4715edf2877272abb7d7bd306440753db5ad1df5`  | `4715edf2877272abb7d7bd306440753db5ad1df5` |
| `d8af52113cd1ba49a5aad6b2823fb8a477dcab7a`  | `-2750adeec32e45b65a55294d7dc0475b88235486` |
| `00a101634fa8534b782c798e966fecaf81d269cc`  | `a101634fa8534b782c798e966fecaf81d269cc`   |

---

## Security model

* **The Mojang access token never reaches the MC Auth server.** It is sent to exactly one host:
  `sessionserver.mojang.com` (`/session/minecraft/join`). The mock end-to-end test asserts that the
  token string appears in the Mojang request and in none of the `/api/v1/auth/*` request bodies.
* **The server proves identity with Mojang itself.** It calls `hasJoined` with the username and the
  client-computed hash and only trusts Mojang's answer. If Mojang says "no such session" the server
  answers `401 NOT_A_PREMIUM_SESSION`; if Mojang is down it answers `503 MOJANG_UNAVAILABLE`
  (retryable) - never a token.
* **Client claims are ignored.** The `playerUuid`, username and any "premium" flag the client sends are
  used only to build the Mojang join payload locally. The UUID and scopes in the response come from
  Mojang and MongoDB, and the SDK uses `tokens.profile()` - never the local values - for anything
  security-relevant.
* **Secrets stay local.** The 16-byte shared secret and the 4-byte verify token are RSA-encrypted with
  the server's per-deployment public key (`RSA/ECB/PKCS1Padding`) and are never transmitted in clear.
  The shared secret is generated with `SecureRandom` per login and discarded.
* **Challenges are single use.** A consumed or expired challenge yields `409 CHALLENGE_CONSUMED` /
  `410 CHALLENGE_EXPIRED`; the SDK does not silently retry, because a retry would replay a nonce.
* **No secret logging.** `TokenResponse.toString()` redacts both tokens. Exception messages never
  contain tokens or request bodies: a transport failure reports the host and operation only.
* **Refresh tokens rotate.** The returned `refreshToken` is the only one that works next time; keep it
  in memory or an OS keystore, never in a log line, chat message or world file. Replaying a rotated
  token gets `401 REFRESH_REUSED` and revokes the session.
* **HTTPS is expected.** `baseUrl` may be `http://` for a local dev server, but production traffic
  must be TLS; the SDK does not add certificate pinning (pass a configured `HttpClient` if you need it).

---

## API reference

### `McAuthClient`

| Method | Description |
| --- | --- |
| `builder(String baseUrl)` | starts the builder (`http`/`https`, no trailing slash needed) |
| `.connectTimeout(Duration)` / `.requestTimeout(Duration)` | transport timeouts, defaults 5 s / 10 s |
| `.httpClient(HttpClient)` | reuse a shared client (proxy, custom TLS, executor) |
| `.mojangSessionServer(String)` | override `https://sessionserver.mojang.com` (tests / mirrors) |
| `.challengePath/.verifyPath/.refreshPath/.logoutPath(String)` | override default endpoint paths |
| `requestChallenge(String username)` | `POST /api/v1/auth/minecraft/challenge` -> `ChallengeResponse` |
| `authenticate(String accessToken, String playerUuid, String username)` | full join + verify -> `TokenResponse` |
| `authenticate(SessionProvider session)` | same, values from the launcher session |
| `refresh(String refreshToken)` | `POST /api/v1/auth/refresh` -> `TokenResponse` |
| `logout(String accessToken)` | `POST /api/v1/auth/logout` with `Authorization: Bearer ...` |

Endpoint defaults: `/api/v1/auth/minecraft/challenge`, `/api/v1/auth/minecraft/verify`,
`/api/v1/auth/refresh`, `/api/v1/auth/logout`. They are constants on `McAuthClient` and overridable,
so a route change needs no fork.

### `McAuthException`

```java
try {
    client.authenticate(session);
} catch (McAuthException e) {
    e.errorCode();   // "NOT_A_PREMIUM_SESSION", "CHALLENGE_CONSUMED", "MOJANG_UNAVAILABLE", ...
    e.httpStatus();  // 401 / 409 / 503, or 0 when no response was received
    e.retryable();   // true for 429/5xx/transport failures
    e.details();     // optional error.details JSON value
}
```

| Code | HTTP | Retryable | Suggested reaction |
| --- | --- | --- | --- |
| `NOT_A_PREMIUM_SESSION` | 401 | no | Not a premium session: ask the player to restart the launcher/game |
| `CHALLENGE_CONSUMED` | 409 | no | Start a new login (fresh challenge) |
| `CHALLENGE_EXPIRED` | 410 | no | Start a new login |
| `CHALLENGE_NOT_FOUND` | 404 | no | Start a new login |
| `MOJANG_UNAVAILABLE` | 503 | **yes** | Back off and retry with a new challenge |
| `RATE_LIMITED` | 429 | **yes** | Wait `details.retryAfterSeconds` |
| `USER_BANNED` | 403 | no | Show the ban message |
| `REFRESH_REUSED` / `SESSION_REVOKED` | 401 | no | Session is dead: log in again |
| `TOKEN_EXPIRED` | 401 | yes (refresh) | Call `refresh(refreshToken)` |
| `INVALID_REQUEST` | 400 | no | Client bug - fix the request |
| `TRANSPORT_ERROR` | - | **yes** | Network problem: retry later (SDK-local code) |
| `INVALID_RESPONSE` | - | no | Server/proxy returned something unexpected (SDK-local code) |
| `MOJANG_JOIN_REJECTED` | - | no | Launcher session invalid/expired: restart the game (SDK-local code) |

### `SessionProvider`

```java
public interface SessionProvider {
    String accessToken();
    String playerUuid();
    String username();
}
```

Implementations are trivial: read the token from wherever your host keeps it. A Fabric example lives
in `examples/fabric-mod/SkymatrixAuthClient.java.example` (outside this library, never compiled here).

### `MinecraftServerHash` / `HandshakeCrypto`

Public because they are useful for tests and diagnostics, and because the hash is the one piece of the
protocol that is easy to get subtly wrong:

```java
byte[] digest = MinecraftServerHash.digest(serverId, sharedSecret, publicKeyDer);
String hash   = MinecraftServerHash.compute(serverId, sharedSecret, publicKeyDer);
byte[] secret = HandshakeCrypto.generateSharedSecret();          // 16 bytes
String enc    = HandshakeCrypto.rsaEncryptBase64(publicKeyDer, secret);
```

---

## Build and test standalone

PowerShell (this is the command used in CI evidence for this SDK):

```powershell
cd clients\skymatrix-sdk-java
Get-ChildItem -Recurse -Filter *.java | ForEach-Object { $_.FullName } | Set-Content sources.txt
javac -d out "@sources.txt"
```

Run the checks:

```powershell
java -cp out cn.seiua.mcauth.ServerHashSelfTest
java -cp out cn.seiua.mcauth.EndToEndSelfTest
java -cp out cn.seiua.mcauth.Main
```

`ServerHashSelfTest` verifies the hash against vectors produced by the server's own implementation,
exercises signed-hex edge cases, cross-checks 700 random inputs against an independent reference
implementation, round-trips an RSA-1024 handshake, exercises the JSON reader/writer and the error
envelope. `EndToEndSelfTest` starts a loopback mock that behaves like both the MC Auth server and
Mojang, decrypts the client's ciphertexts with a real RSA key, and asserts the whole flow including
token rotation, logout and error codes. Neither touches the network.

The plain demo prints the flow with placeholders and performs **no** HTTP calls:

```
java -cp out cn.seiua.mcauth.Main
```

Real calls happen only with explicit arguments:

```
java -cp out cn.seiua.mcauth.Main <baseUrl> <username>
java -cp out cn.seiua.mcauth.Main <baseUrl> <username> <minecraftAccessToken> <playerUuid>
```

---

## Using it from a Fabric mod

### build.gradle (Loom) snippet

```groovy
plugins {
    id 'fabric-loom' version '1.9-SNAPSHOT'
    id 'maven-publish'
}

version = '0.1.0'
group = 'cn.seiua'

repositories {
    mavenCentral()
    maven { url = 'https://maven.fabricmc.net/' }
}

dependencies {
    minecraft "com.mojang:minecraft:1.21.1"
    mappings "net.fabricmc:yarn:1.21.1+build.3:v2"
    modImplementation "net.fabricmc:fabric-loader:0.16.5"
    modImplementation "net.fabricmc.fabric-api:fabric-api:0.102.0+1.21.1"

    // Option A - prebuilt SDK jar, nested into your mod (Jar-in-Jar, nothing for players to install):
    include files('libs/skymatrix-mcauth-java-0.1.0.jar')

    // Option B - while developing against this checkout:
    // compileOnly files('../skymatrix-sdk-java/out')
}

java {
    toolchain { languageVersion = JavaLanguageVersion.of(21) }
}
```

To produce the jar from this directory:

```powershell
javac -d out "@sources.txt"
jar --create --file libs/skymatrix-mcauth-java-0.1.0.jar -C out .
```

**Simplest alternative:** because the SDK is dependency-free, vendor the sources into your client
source set instead of building a jar:

```groovy
loom { splitEnvironmentSourceSets() }

sourceSets {
    client {
        java.srcDir '../../clients/skymatrix-sdk-java/src/main/java'
    }
}
```

(Adjust the path; exact Loom DSL varies by Loom version.)

### Client-only rules

1. Never reference `McAuthClient` from common/server code - keep it in the `client` source set behind
   `@Environment(EnvType.CLIENT)`.
2. Never call `authenticate`/`refresh`/`logout` on the render thread; they block. Use
   `CompletableFuture.supplyAsync(..., Util.getIoWorkerExecutor())` and hop back with
   `MinecraftClient.getInstance().execute(...)`.
3. Store the refresh token in your config/keystore. Do not log tokens; `TokenResponse.toString()` is
   already redacted, but a getter is not.
4. `logout` before the player switches accounts, and treat `REFRESH_REUSED` as "log in again".

''s client source
set and adjust the package.

---

## Design notes

* **HTTP**: `java.net.http.HttpClient` with a connect timeout and a per-request timeout; redirects are
  not followed (a redirect on the challenge endpoint would be suspicious).
* **JSON**: `cn.seiua.mcauth.json.Json` is a small recursive-descent parser and serializer with a
  depth limit, strict syntax and typed accessors. It intentionally supports only what the API uses.
* **Numbers**: integers parse to `Long` (or `BigDecimal` when they overflow), fractions to `Double`.
* **Thread-safety**: `McAuthClient`, `MinecraftServerHash`, `HandshakeCrypto` and `Json` are stateless
  or immutable. `TokenResponse`/`ChallengeResponse` are records.
* **No retries inside the SDK**: challenge-based operations are single-use. Retry only when
  `McAuthException.retryable()` is true, and start from `requestChallenge` again.

---

## IRC client (SRP v1)

Real-time half of the SDK: WSS at `wss://host/v1/connect`, JDK `java.net.http.WebSocket`, no Netty or
OkHttp. The same JWT from the auth half authenticates it (scope `skymatrix:ircserver`).

```java
IrcClient irc = IrcClient.builder("wss://irc.example.com")
        .tokenProvider(() -> session.accessToken())
        .dispatchExecutor(client::execute)            // callbacks on the game thread
        .build();

irc.on("chat.message", message -> chat.show(message.text()));
irc.on("skymatrix.*", message -> mod.handle(message.type(), message.payload()));
irc.onAck(ack -> { if (ack.isFailed()) log.warn("send failed: {}", ack.reason()); });
irc.onError(error -> log.warn("irc error {}", error));

irc.connect().join();                                  // resolves with READY
irc.sendDirect(targetUuid, "chat.message", Map.of("text", "hello"));
irc.sendGroup(groupId, "skymatrix.party.state", Map.of("phase", "ready"));
irc.close();
```

| Method | Purpose |
| --- | --- |
| `connect()` / `close()` | Open the socket (future resolves on `READY`) / shut it down |
| `sendDirect / sendGroup / sendBroadcast` | Fire-and-forget; the id comes back immediately |
| `sendDirectAsync / sendGroupAsync / sendBroadcastAsync` | Resolve with the **final** ACK (`delivered` or `failed`) |
| `on(pattern, handler)` | Type routing: `chat.message`, `chat.*`, `*` |
| `onMessage / onAck / onError / onStateChange` | Cross-cutting listeners |
| `ping()` | Application-level keepalive |

Behaviour: ACK `delivered` means "enqueued on the recipient's socket", not "processed"; a 401/403 during
the upgrade triggers `TokenProvider.onTokenRejected()` once and a single retry; reconnects use
exponential backoff with jitter (500 ms → 30 s); received ids are de-duplicated (LRU 512); sending while
disconnected throws `NOT_CONNECTED` — there is no offline queue on either side.

## REST client (groups, presence, filters)

Configuration calls are plain HTTPS with the same JWT; `IrcRestClient` wraps them.

```java
IrcRestClient api = IrcRestClient.builder("wss://irc.example.com").tokenProvider(() -> jwt).build();

IrcRestClient.Group group = api.groups().create("周末小队", "PRIVATE", 20);
api.groups().addMember(group.id(), friendUuid, "MEMBER");
api.groups().setMemberRole(group.id(), friendUuid, "ADMIN");   // OWNER is not assignable
api.groups().delete(group.id());                               // OWNER only

api.presence().me();
api.presence().of(uuid);                                       // self / shared-group only

api.filters().replaceMine(List.of(IrcRestClient.RuleSpec.deny("chat.typing")));
api.filters().groupRules(groupId);
api.filters().globalRules();                                   // admin only
```

Non-2xx answers become `ApiException` carrying the server's code, `statusCode()`, `isNotFound()`,
`isForbidden()`. HTTP/1.1 is pinned: over cleartext HTTP the JDK would otherwise send an `h2c` upgrade,
which is not a WebSocket upgrade and confuses upgrade-aware servers.

## Build, test and release

```bash
bash build.sh              # compiles, runs the 6 offline self-tests, writes dist/*.jar
bash build.sh 1.2.3        # same, stamped with a version
```

`build.sh` uses only `javac`/`jar` — the same commands CI runs. End-to-end suites need a live relay:

```bash
IRC_URL=ws://127.0.0.1:3001/v1/connect IRC_TOKEN=<jwt> java -cp out cn.seiua.irc.IrcE2ESelfTest
IRC_HTTP_URL=http://127.0.0.1:3001 IRC_TOKEN=<jwt> java -cp out cn.seiua.irc.rest.IrcRestE2ETest
```

`.github/workflows/release-java-sdk.yml` builds on every **published GitHub Release** (and on manual
dispatch), runs the self-tests, then attaches `skymatrix-sdk-java-<version>.jar`, the sources jar and
`SHA256SUMS.txt` to that release. A red build cannot publish a jar: the upload step only runs after the
tests pass.
