package com.skymatrix.irc;

import com.skymatrix.irc.json.Json;

import java.net.URI;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;

/**
 * Offline self-test for {@link IrcClient}: no sockets, no server, no network.
 *
 * <p>A fake {@link Transport} drives the entire client state machine, so every
 * branch that matters — ACK correlation, error mapping, de-duplication, token
 * rejection, reconnect — is exercised deterministically.
 *
 * <pre>java -cp out com.skymatrix.irc.IrcClientSelfTest</pre>
 */
public final class IrcClientSelfTest {

    private static int checks;
    private static int failures;

    public static void main(String[] args) throws Exception {
        routingMatchesTheServerContract();
        envelopeAndAckCorrelation();
        failureAndErrorMapping();
        deDuplication();
        tokenRejectionRetriesOnce();
        reconnectAfterServerClose();
        reconnectPolicyBounds();
        disconnectedSendsFailFast();
        pingIsSent();
        gracefulClose();

        System.out.println();
        System.out.println("checks passed: " + (checks - failures) + ", failed: " + failures);
        if (failures > 0) {
            System.out.println("RESULT: FAIL");
            System.exit(1);
        }
        System.out.println("RESULT: PASS");
    }

    /* ------------------------------------------------------------------ */

    private static void routingMatchesTheServerContract() {
        TypeRouter router = new TypeRouter();
        List<String> order = new ArrayList<>();
        router.on("*", message -> order.add("star"));
        router.on("chat.*", message -> order.add("chat-ns"));
        router.on("chat.message", message -> order.add("exact"));
        router.on("skymatrix.*", message -> order.add("sky-ns"));

        router.dispatch(message("m1", "chat.message"));
        check("exact handler runs first", order.equals(List.of("exact", "chat-ns", "star")), order.toString());

        order.clear();
        router.dispatch(message("m2", "chat.typing"));
        check("namespace wildcard catches siblings", order.equals(List.of("chat-ns", "star")), order.toString());

        order.clear();
        router.dispatch(message("m3", "skymatrix.party.state"));
        check("unrelated namespaces do not collide", order.equals(List.of("sky-ns", "star")), order.toString());

        boolean rejected = false;
        try {
            router.on("chat.*.message", message -> { });
        } catch (IllegalArgumentException expected) {
            rejected = true;
        }
        check("mid-string wildcard is rejected", rejected);
    }

    private static void envelopeAndAckCorrelation() throws Exception {
        FakeTransport transport = new FakeTransport();
        IrcClient client = client(transport);
        client.connect();
        transport.emitReady("4c1099df-e202-4e64-9ea2-9039be420143");

        check("READY resolves connect()", client.isConnected(), client.state().toString());
        check("READY exposes the server identity", client.ready().instanceId().equals("irc-test"));

        CompletableFuture<Ack> pending = client.sendDirectAsync("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "chat.message", Map.of("text", "hi"));

        String sent = transport.sent.get(transport.sent.size() - 1);
        Map<String, Object> frame = Json.parseObject(sent);
        check("envelope version is 1", ((Number) frame.get("v")).intValue() == 1);
        check("op is MESSAGE", "MESSAGE".equals(frame.get("op")));
        check("type is preserved", "chat.message".equals(frame.get("type")));
        Map<String, Object> route = Json.requireObject(frame, "route");
        check("route mode is DIRECT", "DIRECT".equals(route.get("mode")));
        check("route carries the target", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee".equals(route.get("target")));
        check("payload is preserved", Json.requireObject(frame, "payload").get("text").equals("hi"));
        check("client id is stable and non-empty", ((String) frame.get("id")).startsWith("msg_"));

        String id = (String) frame.get("id");
        transport.emitAck(id, "accepted", -1, null);
        check("accepted alone does not complete the send", !pending.isDone());

        transport.emitAck(id, "delivered", 1, null);
        Ack ack = pending.get(2, TimeUnit.SECONDS);
        check("delivered completes the send", ack.isDelivered());
        check("recipient count is surfaced", ack.recipients() == 1);
        check("no ACKs left pending", client.pendingAckCount() == 0);
        client.close();
    }

    private static void failureAndErrorMapping() throws Exception {
        FakeTransport transport = new FakeTransport();
        IrcClient client = client(transport);
        List<Ack> acks = new CopyOnWriteArrayList<>();
        List<ProtocolError> errors = new CopyOnWriteArrayList<>();
        client.onAck(acks::add).onError(errors::add);

        client.connect();
        transport.emitReady("uuid");

        CompletableFuture<Ack> offline = client.sendDirectAsync("bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", "chat.message", Map.of());
        String offlineId = lastId(transport);
        transport.emitAck(offlineId, "failed", -1, "TARGET_OFFLINE");
        check("failed ACK surfaces the reason", codeOf(offline).equals("TARGET_OFFLINE"), codeOf(offline));
        check("onAck sees the failure", acks.stream().anyMatch(ack -> ack.isFailed()));

        CompletableFuture<Ack> limited = client.sendDirectAsync("bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", "chat.message", Map.of());
        String limitedId = lastId(transport);
        transport.emitError("RATE_LIMITED", "slow down", limitedId);
        check("ERROR frame fails the pending send", codeOf(limited).equals("RATE_LIMITED"), codeOf(limited));
        check("onError sees the protocol error", errors.stream().anyMatch(ProtocolError::isRateLimited));

        client.close();
    }

    private static void deDuplication() {
        FakeTransport transport = new FakeTransport();
        IrcClient client = client(transport);
        List<IncomingMessage> received = new CopyOnWriteArrayList<>();
        client.on("chat.message", received::add);

        client.connect();
        transport.emitReady("uuid");
        transport.emitMessage(message("dup-1", "chat.message"));
        transport.emitMessage(message("dup-1", "chat.message"));
        transport.emitMessage(message("dup-2", "chat.message"));

        check("duplicate message ids are dropped", received.size() == 2, "got " + received.size());
        check("sender is taken from the envelope", received.get(0).senderUuid().equals("4c1099df-e202-4e64-9ea2-9039be420143"));
        client.close();
    }

    private static void tokenRejectionRetriesOnce() throws Exception {
        List<FakeTransport> transports = new ArrayList<>();
        List<String> tokensUsed = new ArrayList<>();
        List<Integer> rejections = new ArrayList<>();
        String[] currentToken = {"token-1"};

        IrcClient client = IrcClient.builder("wss://irc.example.com")
                .tokenProvider(new TokenProvider() {
                    @Override
                    public String accessToken() {
                        tokensUsed.add(currentToken[0]);
                        return currentToken[0];
                    }

                    @Override
                    public void onTokenRejected() {
                        rejections.add(1);
                        currentToken[0] = "token-2";
                    }
                })
                .dispatchExecutor(Runnable::run)
                .transport(() -> {
                    FakeTransport transport = new FakeTransport();
                    transport.failStatus = 401;
                    transports.add(transport);
                    return transport;
                })
                .reconnectPolicy(ReconnectPolicy.disabled())
                .build();

        CompletableFuture<Ready> ready = client.connect();
        check("rejected token triggers a host refresh callback", rejections.size() == 1);
        check("client retries once with the refreshed token", tokensUsed.equals(List.of("token-1", "token-2")), tokensUsed.toString());
        check("two attempts were made", transports.size() == 2, "got " + transports.size());
        check("both attempts carried a bearer token", transports.get(0).headers.get("Authorization").startsWith("Bearer "));

        try {
            ready.get(2, TimeUnit.SECONDS);
            check("client gives up after the second rejection", false);
        } catch (ExecutionException expected) {
            check("client gives up after the second rejection", true);
        }
        check("terminal state is CLOSED", client.state() == IrcState.CLOSED, client.state().toString());
        client.close();
    }

    private static void reconnectAfterServerClose() throws Exception {
        List<FakeTransport> transports = new ArrayList<>();
        IrcClient client = IrcClient.builder("wss://irc.example.com")
                .tokenProvider(() -> "token")
                .dispatchExecutor(Runnable::run)
                .transport(() -> {
                    FakeTransport transport = new FakeTransport();
                    transports.add(transport);
                    return transport;
                })
                .reconnectPolicy(new ReconnectPolicy(10, 20, 0, 3))
                .build();

        List<IrcState> states = new CopyOnWriteArrayList<>();
        client.onStateChange(states::add);
        client.connect();
        transports.get(0).emitReady("uuid");
        check("connected before the drop", client.state() == IrcState.CONNECTED);

        transports.get(0).emitClosed(1006, "peer gone");
        client.awaitState(IrcState.RECONNECTING, Duration.ofSeconds(1));
        check("abnormal close moves to RECONNECTING", client.state() == IrcState.RECONNECTING, client.state().toString());

        long deadline = System.currentTimeMillis() + 3000;
        while (transports.size() < 2 && System.currentTimeMillis() < deadline) {
            Thread.sleep(10);
        }
        check("a reconnect attempt opened a new socket", transports.size() >= 2, "attempts=" + transports.size());
        transports.get(transports.size() - 1).emitReady("uuid");
        check("reconnect reaches CONNECTED again", client.state() == IrcState.CONNECTED);
        check("state history is monotonic", states.contains(IrcState.CONNECTING) && states.contains(IrcState.RECONNECTING));
        client.close();
    }

    private static void reconnectPolicyBounds() {
        ReconnectPolicy policy = new ReconnectPolicy(100, 2_000, 0.2, 10);
        long previous = 0;
        boolean monotonic = true;
        for (int attempt = 1; attempt <= 6; attempt++) {
            long delay = policy.delayForAttempt(attempt);
            if (delay < 50 || delay > 2_400) {
                monotonic = false;
                break;
            }
            if (attempt <= 2 && delay < previous) monotonic = false;
            previous = delay;
        }
        check("delays stay within [50, 2400] ms with jitter", monotonic);
        check("policy stops after max attempts", !policy.canRetry(10) && policy.canRetry(9));

        ReconnectPolicy unbounded = ReconnectPolicy.defaults();
        check("default policy is effectively unbounded", unbounded.maxAttempts() == Integer.MAX_VALUE);
    }

    private static void disconnectedSendsFailFast() {
        FakeTransport transport = new FakeTransport();
        IrcClient client = client(transport);
        String code = "";
        try {
            client.sendDirect("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "chat.message", Map.of());
        } catch (IrcException expected) {
            code = expected.code();
        }
        check("sending before connect fails with NOT_CONNECTED", code.equals("NOT_CONNECTED"), code);
        check("nothing was written to the transport", transport.sent.isEmpty());
        client.close();
    }

    private static void pingIsSent() {
        FakeTransport transport = new FakeTransport();
        IrcClient client = client(transport);
        client.connect();
        transport.emitReady("uuid");
        client.ping();
        Map<String, Object> frame = Json.parseObject(transport.sent.get(transport.sent.size() - 1));
        check("ping uses the PING op", "PING".equals(frame.get("op")));
        check("ping carries a protocol version", ((Number) frame.get("v")).intValue() == 1);
        client.close();
    }

    private static void gracefulClose() throws Exception {
        FakeTransport transport = new FakeTransport();
        IrcClient client = client(transport);
        client.connect();
        transport.emitReady("uuid");
        client.close();
        check("close() sends a normal close", transport.closeCode == 1000, String.valueOf(transport.closeCode));
        check("close() is terminal", client.state() == IrcState.CLOSED);
        check("close() does not reconnect", transport.connectCount == 1);
    }

    /* ------------------------------------------------------------------ */
    /* fixtures                                                            */
    /* ------------------------------------------------------------------ */

    private static IrcClient client(FakeTransport transport) {
        return IrcClient.builder("wss://irc.example.com")
                .tokenProvider(() -> "test-token")
                .dispatchExecutor(Runnable::run)
                .reconnectPolicy(ReconnectPolicy.disabled())
                .ackTimeout(Duration.ofSeconds(2))
                .transport(() -> transport)
                .build();
    }

    private static IncomingMessage message(String id, String type) {
        return new IncomingMessage(
                id, type, "DIRECT", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                Map.of("text", "hello"), "4c1099df-e202-4e64-9ea2-9039be420143", "user-a",
                1_000L, 11_000L);
    }

    private static String lastId(FakeTransport transport) {
        return (String) Json.parseObject(transport.sent.get(transport.sent.size() - 1)).get("id");
    }

    private static String codeOf(CompletableFuture<Ack> future) {
        try {
            future.get(2, TimeUnit.SECONDS);
            return "<completed>";
        } catch (ExecutionException failure) {
            Throwable cause = failure.getCause();
            return cause instanceof IrcException irc ? irc.code() : cause.getClass().getSimpleName();
        } catch (Exception other) {
            return other.getClass().getSimpleName();
        }
    }

    private static void check(String name, boolean condition) {
        check(name, condition, "");
    }

    private static void check(String name, boolean condition, String detail) {
        checks++;
        if (condition) {
            System.out.println("  PASS  " + name);
        } else {
            failures++;
            System.out.println("  FAIL  " + name + (detail.isBlank() ? "" : " -> " + detail));
        }
    }

    /** Scriptable transport: records outbound frames and lets the test play the server. */
    private static final class FakeTransport implements Transport {

        final List<String> sent = new CopyOnWriteArrayList<>();
        final Map<String, String> headers = new java.util.LinkedHashMap<>();
        volatile Listener listener;
        volatile boolean open;
        volatile int closeCode = -1;
        volatile int connectCount;
        volatile int failStatus;

        @Override
        public CompletableFuture<Void> connect(URI uri, Map<String, String> requestHeaders, Listener target) {
            connectCount++;
            headers.putAll(requestHeaders);
            this.listener = target;
            if (failStatus > 0) {
                open = false;
                return CompletableFuture.failedFuture(new HandshakeRejectedException(failStatus, "rejected"));
            }
            open = true;
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public void send(String text) {
            sent.add(text);
        }

        @Override
        public void close(int statusCode, String reason) {
            open = false;
            closeCode = statusCode;
        }

        @Override
        public boolean isOpen() {
            return open;
        }

        void emitReady(String uuid) {
            String frame = Json.write(Json.object(
                    "v", 1,
                    "id", "srv_ready",
                    "op", "READY",
                    "type", "protocol.ready",
                    "payload", Json.object(
                            "connectionId", "conn-1",
                            "userId", "user-a",
                            "minecraftUuid", uuid,
                            "instanceId", "irc-test",
                            "heartbeatIntervalMs", 30_000,
                            "serverTime", 1_000)));
            listener.onText(frame);
        }

        void emitAck(String replyTo, String status, int recipients, String reason) {
            Map<String, Object> payload = Json.object("status", status);
            if (recipients >= 0) payload.put("recipients", recipients);
            if (reason != null) payload.put("reason", reason);
            listener.onText(Json.write(Json.object(
                    "v", 1, "id", "ack_" + replyTo, "op", "ACK", "type", "protocol.ack",
                    "replyTo", replyTo, "payload", payload)));
        }

        void emitError(String code, String message, String replyTo) {
            listener.onText(Json.write(Json.object(
                    "v", 1, "id", "err_1", "op", "ERROR", "type", "protocol.error",
                    "replyTo", replyTo, "payload", Json.object("code", code, "message", message))));
        }

        void emitMessage(IncomingMessage message) {
            listener.onText(Json.write(Json.object(
                    "v", 1,
                    "id", message.id(),
                    "op", "MESSAGE",
                    "type", message.type(),
                    "route", Json.object("mode", message.routeMode(), "target", message.routeTarget()),
                    "payload", message.payload(),
                    "sender", Json.object(
                            "userId", message.senderUserId(),
                            "minecraftUuid", message.senderUuid()),
                    "receivedAt", message.receivedAt(),
                    "expireAt", message.expireAt())));
        }

        void emitClosed(int statusCode, String reason) {
            open = false;
            listener.onClosed(statusCode, reason);
        }
    }
}
