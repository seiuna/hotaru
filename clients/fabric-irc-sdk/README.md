# Skymatrix IRC SDK (Java 21)

Dependency-free Java 21 client for the **SkyMatrix Relay Protocol v1** — the real-time relay used by the
Skymatrix mod. JDK only: `java.net.http.WebSocket` for transport, a hand-written JSON reader/writer, no
Netty/OkHttp/Jackson, nothing to shade into a mod jar.

**No Minecraft dependency.** The library never imports Minecraft or Fabric. Two interfaces connect it to
your app: `TokenProvider` (give it a JWT) and an `Executor` (where callbacks run).

```java
IrcClient irc = IrcClient.builder("wss://irc.example.com")
        .tokenProvider(() -> session.accessToken())   // MC Auth JWT, scope skymatrix:ircserver
        .dispatchExecutor(client::execute)            // callbacks on the game thread
        .build();

irc.on("chat.message", message -> chat.show(message.text()));
irc.on("skymatrix.*", message -> mod.handle(message.type(), message.payload()));
irc.onAck(ack -> log.debug("ack {}", ack));
irc.onError(error -> log.warn("irc error {}", error));

irc.connect().join();
irc.sendDirect(targetUuid, "chat.message", Map.of("text", "hello"));
irc.sendGroup(groupId, "skymatrix.party.state", Map.of("phase", "ready"));
irc.close();
```

```
clients/fabric-irc-sdk
|-- README.md
|-- fabric-example/FabricIrcExample.java.example   Fabric wiring (not compiled here)
`-- src/
    |-- main/java/com/skymatrix/irc/
    |   |-- IrcClient.java             connect, send, listeners, reconnect, ACK correlation
    |   |-- TokenProvider.java         the only auth input: accessToken() + onTokenRejected()
    |   |-- Transport.java             socket abstraction (tests swap it out)
    |   |-- JdkWebSocketTransport.java production transport on java.net.http
    |   |-- TypeRouter.java            chat.message / chat.* / * dispatch
    |   |-- ReconnectPolicy.java       exponential backoff + jitter
    |   |-- Ready / Ack / IncomingMessage / ProtocolError / IrcException
    |   |-- IrcState.java              DISCONNECTED → CONNECTING → CONNECTED → RECONNECTING → CLOSED
    |   `-- json/Json.java             JSON reader/writer (same value model as the MC Auth SDK)
    `-- test/java/com/skymatrix/irc/
        |-- IrcClientSelfTest.java     44 checks, fake transport, no network
        `-- IrcE2ESelfTest.java        14 checks against a real relay (IRC_URL + IRC_TOKEN)
```

## API

| Method | Purpose |
| --- | --- |
| `connect()` | Opens the socket; the future resolves with the server's `READY` |
| `sendDirect(uuid, type, payload)` / `sendDirectAsync(...)` | Player-to-player message |
| `sendGroup(groupId, type, payload)` / `sendGroupAsync(...)` | Group message (membership checked server-side) |
| `sendBroadcast(type, payload)` / `sendBroadcastAsync(...)` | Needs `skymatrix:irc:broadcast` on the token |
| `on(pattern, handler)` | Type-routed subscription (`chat.message`, `chat.*`, `*`) |
| `onMessage / onAck / onError / onStateChange` | Cross-cutting listeners |
| `ping()` | Application-level keepalive (`PONG` back) |
| `close()` | Closes the socket, stops reconnecting, fails pending sends |

## REST client (groups, presence, filters)

Real-time traffic uses the socket; everything that *configures* it is a plain HTTPS call with the same
JWT. `IrcRestClient` wraps those, so a mod never hand-builds URLs or parses the error envelope:

```java
IrcRestClient api = IrcRestClient.builder("wss://irc.example.com")   // ws(s) or http(s)
        .tokenProvider(() -> session.accessToken())
        .build();

IrcRestClient.Group group = api.groups().create("周末小队", "PRIVATE", 20);
api.groups().list();
api.groups().get(group.id());
api.groups().update(group.id(), "新名字", null, 30);
api.groups().addMember(group.id(), friendUuid, "MEMBER");
api.groups().setMemberRole(group.id(), friendUuid, "ADMIN");   // OWNER is not assignable
api.groups().removeMember(group.id(), friendUuid);
api.groups().delete(group.id());                              // OWNER only

IrcRestClient.PresenceMe me = api.presence().me();
IrcRestClient.PresenceView other = api.presence().of(uuid);   // self / shared-group only

List<IrcRestClient.FilterRule> mine = api.filters().mine();
api.filters().replaceMine(List.of(IrcRestClient.RuleSpec.deny("chat.typing")));
api.filters().groupRules(groupId);
api.filters().globalRules();                                  // admin only
```

Behaviour:

- **Same auth as the socket.** One `TokenProvider`; a 401 triggers `onTokenRejected()` once and the
  call is retried with the refreshed token.
- **Typed errors.** Non-2xx becomes `ApiException` with the server's code
  (`GROUP_ACCESS_DENIED`, `GROUP_NOT_FOUND`, `RATE_LIMITED`, …), `statusCode()`, `isNotFound()`,
  `isForbidden()`.
- **Blocking.** These calls block on HTTP — run them off the render thread.
- **HTTP/1.1 pinned.** Over cleartext HTTP the JDK would otherwise attempt an `h2c` upgrade, which is
  not a WebSocket upgrade and confuses upgrade-aware servers (found while testing against our relay).

## Behaviour worth knowing

- **ACK semantics.** `sendAsync` resolves on the *final* ACK: `delivered` (the server enqueued the frame
  on the recipient's socket) or `failed` (`TARGET_OFFLINE`, `TYPE_DENIED`, `RATE_LIMITED`, …). The
  intermediate `accepted` is exposed through `onAck` but does not complete the send. **`delivered` does
  not mean the recipient's mod processed the message.**
- **Token handling.** On an HTTP 401/403 upgrade rejection the SDK calls `TokenProvider.onTokenRejected()`
  once, retries with whatever `accessToken()` returns, and then gives up with `UNAUTHORIZED` — no
  refresh loops.
- **Reconnect.** Exponential backoff with jitter (`500 ms → 30 s`, ±20 %). `404` and a second `401` are
  terminal; everything else retries. `ReconnectPolicy.disabled()` opts out.
- **De-duplication.** Received message ids are remembered (LRU, 512) so a reconnect cannot deliver the
  same message twice to your handlers.
- **No offline queue.** `send*` while disconnected throws `NOT_CONNECTED`; queue in the host if your UI
  needs it. The server keeps no offline history either.
- **Threading.** All callbacks run on the `dispatchExecutor`; with a Fabric client pass
  `client::execute` and touch game state freely.

## Build and test (JDK 21)

```bash
cd clients/fabric-irc-sdk
Get-ChildItem -Recurse -Filter *.java | ForEach-Object { $_.FullName } | Set-Content sources.txt
javac --release 21 -Xlint:all -d out "@sources.txt"
java -cp out com.skymatrix.irc.IrcClientSelfTest        # 44 checks, offline
java -cp out com.skymatrix.irc.Main                     # API demo, no network
java -cp out com.skymatrix.irc.rest.IrcRestClientSelfTest  # 34 checks, offline REST

# end-to-end against a running relay (see docs/irc-deployment.md)
IRC_URL=ws://127.0.0.1:3001/v1/connect IRC_TOKEN=<jwt> \
  java -cp out com.skymatrix.irc.IrcE2ESelfTest         # 14 checks
```

## Not included (deliberate)

- No REST client for group management / presence (`/v1/groups`, `/v1/presence`) — the mod can call them
  with the same JWT and its own HTTP helper; wrapping them is a separate slice.
- No message persistence or offline delivery — that is a server-side feature this protocol does not have.
- No Minecraft classes at all: see `fabric-example/` for the three lines that wire a Fabric client.
