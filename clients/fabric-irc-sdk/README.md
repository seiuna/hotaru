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

# end-to-end against a running relay (see docs/irc-deployment.md)
IRC_URL=ws://127.0.0.1:3001/v1/connect IRC_TOKEN=<jwt> \
  java -cp out com.skymatrix.irc.IrcE2ESelfTest         # 14 checks
```

## Not included (deliberate)

- No REST client for group management / presence (`/v1/groups`, `/v1/presence`) — the mod can call them
  with the same JWT and its own HTTP helper; wrapping them is a separate slice.
- No message persistence or offline delivery — that is a server-side feature this protocol does not have.
- No Minecraft classes at all: see `fabric-example/` for the three lines that wire a Fabric client.
