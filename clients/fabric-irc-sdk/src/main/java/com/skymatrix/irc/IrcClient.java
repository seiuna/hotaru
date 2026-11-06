package com.skymatrix.irc;

import com.skymatrix.irc.json.Json;

import java.net.URI;
import java.net.http.WebSocketHandshakeException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * SkyMatrix Relay Protocol v1 client.
 *
 * <p>Dependency-free (JDK 21 only). It hides the WebSocket, the JSON envelope, ACK
 * correlation, reconnection, de-duplication and token rejection from the mod:
 *
 * <pre>{@code
 * IrcClient irc = IrcClient.builder("wss://irc.example.com")
 *         .tokenProvider(() -> session.accessToken())
 *         .dispatchExecutor(client::execute)      // run callbacks on the game thread
 *         .build();
 *
 * irc.on("chat.message", message -> chatHud.show(message.text()));
 * irc.on("skymatrix.party.state", partyState -> party.apply(partyState.payload()));
 *
 * irc.connect().join();
 * irc.sendDirect(targetUuid, "chat.message", Map.of("text", "hello"));
 * irc.close();
 * }</pre>
 *
 * <p><strong>Threading.</strong> Every callback runs on the configured executor
 * (the JDK's common pool by default). Blocks/reads happen on SDK threads, never on
 * the caller's. All public methods are thread-safe.
 *
 * <p><strong>Reliability contract.</strong> The SDK is best-effort real time: it
 * retries the connection, retries a token once, and correlates ACKs, but it does
 * not queue messages across disconnects (the server keeps no offline history
 * either). A send while disconnected fails fast with {@link IrcException}.
 */
public final class IrcClient implements AutoCloseable {

    private static final String PROTOCOL_VERSION = "1";
    private static final int DEDUPE_CAPACITY = 512;

    private final String endpoint;
    private final Supplier<Transport> transportFactory;
    private final TokenProvider tokenProvider;
    private final Executor dispatchExecutor;
    private final ReconnectPolicy reconnectPolicy;
    private final Duration ackTimeout;
    private final Consumer<String> logger;
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor(runnable -> {
        Thread thread = new Thread(runnable, "skymatrix-irc-sdk");
        thread.setDaemon(true);
        return thread;
    });

    private final TypeRouter router = new TypeRouter();
    private final List<Consumer<Ack>> ackListeners = new CopyOnWriteArrayList<>();
    private final List<Consumer<ProtocolError>> errorListeners = new CopyOnWriteArrayList<>();
    private final List<Consumer<IncomingMessage>> messageListeners = new CopyOnWriteArrayList<>();
    private final List<Consumer<IrcState>> stateListeners = new CopyOnWriteArrayList<>();
    private final Map<String, CompletableFuture<Ack>> pendingAcks = new ConcurrentHashMap<>();
    private final Map<String, Boolean> seenMessageIds = new LinkedHashMap<>(256, 0.75f, true) {
        private static final long serialVersionUID = 1L;

        @Override
        protected boolean removeEldestEntry(Map.Entry<String, Boolean> eldest) {
            return size() > DEDUPE_CAPACITY;
        }
    };

    private final AtomicBoolean closed = new AtomicBoolean(false);
    private volatile IrcState state = IrcState.DISCONNECTED;
    private volatile Transport transport;
    private volatile Ready ready;
    private volatile int attempt;
    private volatile boolean retriedTokenOnce;
    private CompletableFuture<Ready> readyFuture = new CompletableFuture<>();
    private boolean autoConnect = false;

    private IrcClient(Builder builder) {
        this.endpoint = builder.endpoint;
        this.transportFactory = builder.transportFactory;
        this.tokenProvider = builder.tokenProvider;
        this.dispatchExecutor = builder.dispatchExecutor;
        this.reconnectPolicy = builder.reconnectPolicy;
        this.ackTimeout = builder.ackTimeout;
        this.logger = builder.logger;
    }

    public static Builder builder(String baseUrl) {
        return new Builder(baseUrl);
    }

    /* ------------------------------------------------------------------ */
    /* public API                                                          */
    /* ------------------------------------------------------------------ */

    /** Opens the socket and resolves with the server's {@code READY} frame. */
    public synchronized CompletableFuture<Ready> connect() {
        if (closed.get()) throw new IrcException("CLOSED", "client is closed");
        if (state == IrcState.CONNECTED && transport != null && transport.isOpen()) {
            return CompletableFuture.completedFuture(ready);
        }
        autoConnect = true;
        if (readyFuture.isDone()) readyFuture = new CompletableFuture<>();
        attempt = 1;
        retriedTokenOnce = false;
        openSocket();
        return readyFuture;
    }

    public IrcState state() {
        return state;
    }

    public Ready ready() {
        return ready;
    }

    public boolean isConnected() {
        Transport current = transport;
        return state == IrcState.CONNECTED && current != null && current.isOpen();
    }

    /** Registers a handler for a type pattern ({@code chat.message}, {@code ns.*}, {@code *}). */
    public IrcClient on(String typePattern, Consumer<IncomingMessage> handler) {
        router.on(typePattern, message -> dispatch(() -> handler.accept(message)));
        return this;
    }

    /** Every business message, regardless of type. */
    public IrcClient onMessage(Consumer<IncomingMessage> listener) {
        messageListeners.add(message -> dispatch(() -> listener.accept(message)));
        return this;
    }

    public IrcClient onAck(Consumer<Ack> listener) {
        ackListeners.add(ack -> dispatch(() -> listener.accept(ack)));
        return this;
    }

    public IrcClient onError(Consumer<ProtocolError> listener) {
        errorListeners.add(error -> dispatch(() -> listener.accept(error)));
        return this;
    }

    public IrcClient onStateChange(Consumer<IrcState> listener) {
        stateListeners.add(listener);
        dispatch(() -> listener.accept(state));
        return this;
    }

    /** Sends a DIRECT message and returns its id; the ACK arrives via {@link #onAck}. */
    public String sendDirect(String targetUuid, String type, Object payload) {
        return send("DIRECT", requireText(targetUuid, "targetUuid"), type, payload, null);
    }

    /** Sends a GROUP message and returns its id. */
    public String sendGroup(String groupId, String type, Object payload) {
        return send("GROUP", requireText(groupId, "groupId"), type, payload, null);
    }

    /** Sends a BROADCAST (requires {@code skymatrix:irc:broadcast} on the token). */
    public String sendBroadcast(String type, Object payload) {
        return send("BROADCAST", null, type, payload, null);
    }

    /** Same as {@link #sendDirect} but resolves with the final ACK (or fails). */
    public CompletableFuture<Ack> sendDirectAsync(String targetUuid, String type, Object payload) {
        return sendAndAwait("DIRECT", requireText(targetUuid, "targetUuid"), type, payload);
    }

    public CompletableFuture<Ack> sendGroupAsync(String groupId, String type, Object payload) {
        return sendAndAwait("GROUP", requireText(groupId, "groupId"), type, payload);
    }

    public CompletableFuture<Ack> sendBroadcastAsync(String type, Object payload) {
        return sendAndAwait("BROADCAST", null, type, payload);
    }

    /** Application-level keepalive; the server answers {@code PONG}. */
    public void ping() {
        Transport current = requireTransport();
        String id = "ping_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        current.send(Json.write(Json.object("v", 1, "id", id, "op", "PING")));
    }

    /** Closes the socket and stops reconnecting. Idempotent. */
    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) return;
        autoConnect = false;
        setState(IrcState.CLOSED);
        Transport current = transport;
        if (current != null) current.close(1000, "client closing");
        failPending(new IrcException("CLOSED", "client closed"));
        scheduler.shutdownNow();
    }

    public void disconnect() {
        close();
    }

    /* ------------------------------------------------------------------ */
    /* connection                                                          */
    /* ------------------------------------------------------------------ */

    private void openSocket() {
        setState(attempt == 1 ? IrcState.CONNECTING : IrcState.RECONNECTING);
        Transport candidate = transportFactory.get();
        transport = candidate;

        String token;
        try {
            token = tokenProvider.accessToken();
        } catch (RuntimeException failure) {
            failTerminal(new IrcException("TOKEN_UNAVAILABLE", "token provider threw", failure));
            return;
        }
        if (token == null || token.isBlank()) {
            failTerminal(new IrcException("TOKEN_UNAVAILABLE", "token provider returned an empty token"));
            return;
        }

        Map<String, String> headers = Map.of(
                "Authorization", "Bearer " + token,
                "User-Agent", "skymatrix-irc-java/0.1.0");

        candidate.connect(URI.create(endpoint), headers, new Listener())
                .whenComplete((ignored, error) -> {
                    if (error == null) return;
                    handleHandshakeFailure(unwrap(error));
                });
    }

    private void handleHandshakeFailure(Throwable error) {
        int status = statusOf(error);
        log("connect failed: " + error + (status > 0 ? " (HTTP " + status + ")" : ""));

        boolean rejectedToken = status == 401 || status == 403;
        if (rejectedToken) {
            // Ask the host to refresh exactly once per connect sequence: a second
            // rejection means the new token is not enough either, and asking again
            // would only spin.
            if (!retriedTokenOnce) {
                try {
                    tokenProvider.onTokenRejected();
                } catch (RuntimeException ignored) {
                    // Host could not refresh; fall through to terminal.
                }
                retriedTokenOnce = true;
                log("token rejected; retrying once with a fresh token");
                openSocket();
                return;
            }
            failTerminal(new IrcException("UNAUTHORIZED", "server rejected the token (HTTP " + status + ")", error));
            return;
        }
        if (status == 404) {
            failTerminal(new IrcException("NOT_FOUND", "WebSocket endpoint not found", error));
            return;
        }
        scheduleReconnect();
    }

    private void scheduleReconnect() {
        if (closed.get() || !autoConnect) return;
        if (!reconnectPolicy.canRetry(attempt)) {
            failTerminal(new IrcException("RECONNECT_EXHAUSTED", "gave up after " + attempt + " attempts"));
            return;
        }
        long delay = reconnectPolicy.delayForAttempt(attempt);
        attempt += 1;
        setState(IrcState.RECONNECTING);
        log("reconnecting in " + delay + " ms (attempt " + attempt + ")");
        scheduler.schedule(() -> {
            if (closed.get()) return;
            openSocket();
        }, delay, TimeUnit.MILLISECONDS);
    }

    private void failTerminal(RuntimeException failure) {
        autoConnect = false;
        setState(IrcState.CLOSED);
        completeReady(failure);
        failPending(failure);
    }

    /* ------------------------------------------------------------------ */
    /* inbound frames                                                      */
    /* ------------------------------------------------------------------ */

    private final class Listener implements Transport.Listener {

        @Override
        public void onText(String text) {
            Map<String, Object> frame;
            try {
                frame = Json.parseObject(text);
            } catch (RuntimeException malformed) {
                log("dropping malformed frame: " + malformed.getMessage());
                return;
            }
            String op = Json.optString(frame, "op");
            if (op == null) return;
            switch (op) {
                case "READY" -> handleReady(frame);
                case "ACK" -> handleAck(frame);
                case "ERROR" -> handleError(frame);
                case "MESSAGE" -> handleMessage(frame);
                case "PONG" -> { /* keepalive answered */ }
                default -> log("ignoring unknown op " + op);
            }
        }

        @Override
        public void onClosed(int statusCode, String reason) {
            log("socket closed: " + statusCode + " " + reason);
            if (closed.get()) return;
            scheduleReconnect();
        }

        @Override
        public void onFailure(Throwable error) {
            log("socket failure: " + error);
            if (closed.get()) return;
            scheduleReconnect();
        }
    }

    private void handleReady(Map<String, Object> frame) {
        Map<String, Object> payload = Json.requireObject(frame, "payload");
        Ready readyFrame = new Ready(
                String.valueOf(payload.getOrDefault("connectionId", "")),
                String.valueOf(payload.getOrDefault("userId", "")),
                String.valueOf(payload.getOrDefault("minecraftUuid", "")),
                String.valueOf(payload.getOrDefault("instanceId", "")),
                ((Number) payload.getOrDefault("heartbeatIntervalMs", 30_000L)).longValue(),
                ((Number) payload.getOrDefault("serverTime", 0L)).longValue());
        this.ready = readyFrame;
        this.attempt = 1;
        this.retriedTokenOnce = false;
        setState(IrcState.CONNECTED);
        completeReady(null);
    }

    private void handleAck(Map<String, Object> frame) {
        String replyTo = Json.optString(frame, "replyTo");
        Map<String, Object> payload = Json.requireObject(frame, "payload");
        String status = String.valueOf(payload.getOrDefault("status", ""));
        int recipients = payload.get("recipients") instanceof Number number ? number.intValue() : -1;
        String reason = Json.optString(payload, "reason");
        Ack ack = new Ack(replyTo, status, recipients, reason);

        ackListeners.forEach(listener -> listener.accept(ack));

        CompletableFuture<Ack> pending = replyTo == null ? null : pendingAcks.get(replyTo);
        if (pending == null) return;
        // `accepted` is an intermediate stage: keep waiting for delivered/failed.
        if ("accepted".equals(status)) return;
        pendingAcks.remove(replyTo);
        if ("delivered".equals(status)) {
            pending.complete(ack);
        } else {
            pending.completeExceptionally(new IrcException(
                    reason == null ? "SEND_FAILED" : reason, "send failed: " + reason));
        }
    }

    private void handleError(Map<String, Object> frame) {
        Map<String, Object> payload = Json.requireObject(frame, "payload");
        String code = String.valueOf(payload.getOrDefault("code", "UNKNOWN"));
        String message = String.valueOf(payload.getOrDefault("message", ""));
        String replyTo = Json.optString(frame, "replyTo");
        ProtocolError error = new ProtocolError(code, message, replyTo);

        errorListeners.forEach(listener -> listener.accept(error));
        if (replyTo != null) {
            CompletableFuture<Ack> pending = pendingAcks.remove(replyTo);
            if (pending != null) pending.completeExceptionally(new IrcException(code, message));
        }
        if ("UNAUTHORIZED".equals(code) || "TOKEN_EXPIRED".equals(code) || "SESSION_REVOKED".equals(code)) {
            // The server is about to drop us; stop retrying with the same token.
            try {
                tokenProvider.onTokenRejected();
            } catch (RuntimeException ignored) {
                // Host-side refresh is best effort.
            }
        }
    }

    private void handleMessage(Map<String, Object> frame) {
        IncomingMessage message;
        try {
            message = TypeRouter.parse(frame);
        } catch (RuntimeException malformed) {
            log("dropping malformed MESSAGE: " + malformed.getMessage());
            return;
        }
        // Client-side de-duplication: a reconnect can replay a frame.
        synchronized (seenMessageIds) {
            if (seenMessageIds.putIfAbsent(message.id(), Boolean.TRUE) != null) return;
        }

        router.dispatch(message);
        messageListeners.forEach(listener -> listener.accept(message));
    }

    /* ------------------------------------------------------------------ */
    /* outbound                                                            */
    /* ------------------------------------------------------------------ */

    private String send(String mode, String target, String type, Object payload, String replyTo) {
        Transport current = requireTransport();

        String messageId = "msg_" + UUID.randomUUID().toString().replace("-", "").substring(0, 20);
        Map<String, Object> route = new LinkedHashMap<>();
        route.put("mode", mode);
        route.put("target", target);

        Map<String, Object> frame = new LinkedHashMap<>();
        frame.put("v", 1);
        frame.put("id", messageId);
        frame.put("op", "MESSAGE");
        frame.put("type", requireText(type, "type"));
        frame.put("route", route);
        frame.put("payload", payload == null ? Map.of() : payload);
        if (replyTo != null) frame.put("replyTo", replyTo);

        current.send(Json.write(frame));
        return messageId;
    }

    private CompletableFuture<Ack> sendAndAwait(String mode, String target, String type, Object payload) {
        String messageId = send(mode, target, type, payload, null);
        CompletableFuture<Ack> pending = new CompletableFuture<>();
        pendingAcks.put(messageId, pending);
        scheduler.schedule(() -> {
            CompletableFuture<Ack> stillPending = pendingAcks.remove(messageId);
            if (stillPending != null) {
                stillPending.completeExceptionally(
                        new IrcException("ACK_TIMEOUT", "no final ACK for " + messageId));
            }
        }, ackTimeout.toMillis(), TimeUnit.MILLISECONDS);
        return pending;
    }

    private Transport requireTransport() {
        if (closed.get()) throw new IrcException("CLOSED", "client is closed");
        Transport current = transport;
        if (state != IrcState.CONNECTED || current == null || !current.isOpen()) {
            throw new IrcException("NOT_CONNECTED", "connect() first; state=" + state);
        }
        return current;
    }

    /* ------------------------------------------------------------------ */
    /* helpers                                                             */
    /* ------------------------------------------------------------------ */

    private void setState(IrcState next) {
        if (state == next) return;
        state = next;
        List<Consumer<IrcState>> listeners = new ArrayList<>(stateListeners);
        listeners.forEach(listener -> dispatch(() -> listener.accept(next)));
    }

    private void completeReady(RuntimeException failure) {
        CompletableFuture<Ready> future = readyFuture;
        if (future.isDone()) return;
        if (failure == null) future.complete(ready);
        else future.completeExceptionally(failure);
    }

    private void failPending(RuntimeException failure) {
        pendingAcks.forEach((id, future) -> future.completeExceptionally(failure));
        pendingAcks.clear();
    }

    private void dispatch(Runnable action) {
        try {
            dispatchExecutor.execute(action);
        } catch (RuntimeException rejected) {
            // A saturated executor must not break the socket reader.
            action.run();
        }
    }

    private void log(String message) {
        logger.accept("[irc-sdk] " + message);
    }

    private static String requireText(String value, String name) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " is blank");
        return value;
    }

    private static Throwable unwrap(Throwable error) {
        Throwable current = error;
        while ((current instanceof CompletionException || current instanceof java.util.concurrent.ExecutionException)
                && current.getCause() != null) {
            current = current.getCause();
        }
        return current;
    }

    private static int statusOf(Throwable error) {
        if (error instanceof HandshakeRejectedException rejected) {
            return rejected.statusCode();
        }
        if (error instanceof WebSocketHandshakeException handshake) {
            return handshake.getResponse().statusCode();
        }
        return 0;
    }

    /* ------------------------------------------------------------------ */
    /* builder                                                             */
    /* ------------------------------------------------------------------ */

    public static final class Builder {

        private final String endpoint;
        private Supplier<Transport> transportFactory = () -> new JdkWebSocketTransport(Duration.ofSeconds(10));
        private TokenProvider tokenProvider = () -> {
            throw new IrcException("TOKEN_UNAVAILABLE", "no TokenProvider configured");
        };
        private Executor dispatchExecutor = Runnable::run;
        private ReconnectPolicy reconnectPolicy = ReconnectPolicy.defaults();
        private Duration ackTimeout = Duration.ofSeconds(15);
        private Consumer<String> logger = message -> { };

        private Builder(String baseUrl) {
            this.endpoint = normalizeEndpoint(requireText(baseUrl, "baseUrl"));
        }

        /** Supplies the JWT for the upgrade. Required. */
        public Builder tokenProvider(TokenProvider provider) {
            this.tokenProvider = Objects.requireNonNull(provider, "tokenProvider");
            return this;
        }

        /** Runs every callback here — pass the game's client executor in a mod. */
        public Builder dispatchExecutor(Executor executor) {
            this.dispatchExecutor = Objects.requireNonNull(executor, "dispatchExecutor");
            return this;
        }

        public Builder reconnectPolicy(ReconnectPolicy policy) {
            this.reconnectPolicy = Objects.requireNonNull(policy, "reconnectPolicy");
            return this;
        }

        public Builder ackTimeout(Duration timeout) {
            this.ackTimeout = Objects.requireNonNull(timeout, "ackTimeout");
            return this;
        }

        /** Replaces the socket implementation (tests, or a custom transport). */
        public Builder transport(Supplier<Transport> factory) {
            this.transportFactory = Objects.requireNonNull(factory, "transportFactory");
            return this;
        }

        public Builder logger(Consumer<String> logger) {
            this.logger = Objects.requireNonNull(logger, "logger");
            return this;
        }

        public IrcClient build() {
            return new IrcClient(this);
        }

        /**
         * Accepts {@code https://host}, {@code http://host}, {@code wss://host} or
         * {@code ws://host} and always produces the documented {@code /v1/connect} path.
         */
        private static String normalizeEndpoint(String baseUrl) {
            String value = baseUrl.trim();
            if (value.startsWith("https://")) value = "wss://" + value.substring("https://".length());
            else if (value.startsWith("http://")) value = "ws://" + value.substring("http://".length());
            else if (!value.startsWith("wss://") && !value.startsWith("ws://")) {
                throw new IllegalArgumentException("baseUrl must be http(s):// or ws(s)://, got " + baseUrl);
            }
            while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
            if (value.endsWith("/v1/connect")) return value;
            return value + "/v1/connect";
        }
    }

    /** Exposed for tests: total pending ACKs. */
    int pendingAckCount() {
        return pendingAcks.size();
    }

    /** Exposed for tests: whether a message id was already de-duplicated. */
    boolean hasSeen(String messageId) {
        synchronized (seenMessageIds) {
            return seenMessageIds.containsKey(messageId);
        }
    }

    /** Waits for the connection to close, used by demos and tests. */
    void awaitState(IrcState expected, Duration timeout) throws InterruptedException, TimeoutException {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (state != expected) {
            if (System.nanoTime() > deadline) throw new TimeoutException("state is " + state);
            Thread.sleep(10);
        }
    }
}
