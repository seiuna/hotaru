package com.skymatrix.mcauth.bridge;

import com.skymatrix.mcauth.TokenResponse;
import com.skymatrix.mcauth.json.Json;
import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/**
 * Loopback HTTP bridge between a browser page and the Minecraft client.
 *
 * <p>Why it exists: a browser cannot obtain a Minecraft access token, so the console cannot perform
 * the premium handshake itself. The mod can. This bridge lets a page that the player explicitly
 * trusts ask the game for a token, the same way desktop OAuth clients receive a callback on
 * {@code 127.0.0.1}.
 *
 * <pre>
 * browser (allowlisted origin)
 *    │  POST http://127.0.0.1:8765/v1/login      (CORS + Private Network Access preflight)
 *    ▼
 * LocalAuthBridge ── ApprovalGate ──► in-game prompt "allow this site?"
 *    │                                   │ yes
 *    │                                   ▼
 *    └────────────── TokenMinter ──► McAuthClient.authenticate(session) ──► auth server ──► Mojang
 *    │
 *    └── 200 {accessToken, refreshToken, profile, scopes}
 * </pre>
 *
 * <p><strong>Security model</strong>
 * <ul>
 *   <li>Binds loopback only; a LAN address is rejected by {@link BridgeConfig}.</li>
 *   <li>Every request must carry an {@code Origin} that is on the configured allowlist — there is no
 *       wildcard, and the response echoes only that exact origin.</li>
 *   <li>The {@code Host} header must be loopback, which defeats DNS-rebinding attacks that would
 *       otherwise let {@code evil.example} reach this port.</li>
 *   <li>No token is ever returned without a fresh approval from {@link ApprovalGate}.</li>
 *   <li>Per-origin rate limiting bounds how many handshakes a page can trigger.</li>
 *   <li>No caching: every response is {@code Cache-Control: no-store}.</li>
 * </ul>
 *
 * <p>The bridge is intentionally ephemeral — create it while the player is logged in, close it when
 * the game exits or the player logs out.
 */
public final class LocalAuthBridge implements AutoCloseable {

    public static final String SERVICE_NAME = "skymatrix-local-auth";
    public static final String VERSION = "0.1.0";

    private static final String HEADER_ORIGIN = "Origin";
    private static final String HEADER_HOST = "Host";
    private static final int MAX_BODY_BYTES = 8 * 1024;

    private final BridgeConfig config;
    private final TokenMinter minter;
    private final ApprovalGate gate;
    private final Consumer<String> logger;
    private final Map<String, Deque<Long>> requestLog = new ConcurrentHashMap<>();

    private HttpServer server;
    private ExecutorService executor;
    private volatile boolean closed;

    private LocalAuthBridge(
            BridgeConfig config, TokenMinter minter, ApprovalGate gate, Consumer<String> logger) {
        this.config = config;
        this.minter = minter;
        this.gate = gate;
        this.logger = logger;
    }

    /** Starts the bridge and returns it; call {@link #close()} to stop it. */
    public static LocalAuthBridge start(
            BridgeConfig config, TokenMinter minter, ApprovalGate gate) throws IOException {
        return start(config, minter, gate, message -> { });
    }

    public static LocalAuthBridge start(
            BridgeConfig config,
            TokenMinter minter,
            ApprovalGate gate,
            Consumer<String> logger) throws IOException {
        LocalAuthBridge bridge = new LocalAuthBridge(config, minter, gate, logger);
        bridge.bind();
        return bridge;
    }

    private void bind() throws IOException {
        server = HttpServer.create(new InetSocketAddress(config.bindAddress(), config.port()), 16);
        executor = Executors.newCachedThreadPool(runnable -> {
            Thread thread = new Thread(runnable, "skymatrix-auth-bridge");
            thread.setDaemon(true);
            return thread;
        });
        server.setExecutor(executor);
        server.createContext("/", this::handle);
        server.start();
        logger.accept("local auth bridge listening on http://" + config.bindAddress() + ":" + port()
                + " for origins " + config.allowedOrigins());
    }

    /** The actual bound port (useful when the config asked for {@code 0}). */
    public int port() {
        if (server == null) return config.port();
        return server.getAddress().getPort();
    }

    public BridgeConfig config() {
        return config;
    }

    @Override
    public void close() {
        if (closed) return;
        closed = true;
        if (server != null) server.stop(0);
        if (executor != null) {
            executor.shutdownNow();
            try {
                executor.awaitTermination(2, TimeUnit.SECONDS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        }
        logger.accept("local auth bridge stopped");
    }

    /* ------------------------------------------------------------------ */
    /* request handling                                                    */
    /* ------------------------------------------------------------------ */

    private void handle(HttpExchange exchange) throws IOException {
        try {
            Headers headers = exchange.getRequestHeaders();
            String origin = headers.getFirst(HEADER_ORIGIN);
            boolean allowedOrigin = config.allows(origin);
            boolean preflight = "OPTIONS".equalsIgnoreCase(exchange.getRequestMethod());

            writeCommonHeaders(exchange, allowedOrigin ? origin : null);

            if (!hostIsLoopback(headers.getFirst(HEADER_HOST))) {
                // DNS rebinding: a page on an attacker domain resolving to 127.0.0.1.
                fail(exchange, 403, "HOST_NOT_ALLOWED", "Host header must be loopback");
                return;
            }

            if (preflight) {
                if (!allowedOrigin) {
                    fail(exchange, 403, "ORIGIN_NOT_ALLOWED", "origin is not on the allowlist");
                    return;
                }
                exchange.sendResponseHeaders(204, -1);
                exchange.close();
                return;
            }

            String path = exchange.getRequestURI().getPath();
            String method = exchange.getRequestMethod().toUpperCase(Locale.ROOT);

            if ("GET".equals(method) && "/v1/health".equals(path)) {
                // Health is safe to answer without an Origin (curl, monitoring), but never with a
                // non-allowlisted browser origin.
                if (origin != null && !allowedOrigin) {
                    fail(exchange, 403, "ORIGIN_NOT_ALLOWED", "origin is not on the allowlist");
                    return;
                }
                respondJson(exchange, 200, Json.object(
                        "ok", Boolean.TRUE,
                        "service", SERVICE_NAME,
                        "version", VERSION,
                        "port", port(),
                        "requiresApproval", Boolean.TRUE));
                return;
            }

            if ("POST".equals(method) && "/v1/login".equals(path)) {
                handleLogin(exchange, origin, allowedOrigin);
                return;
            }

            fail(exchange, 404, "NOT_FOUND", "no such endpoint");
        } catch (Exception unexpected) {
            logger.accept("bridge request failed: " + unexpected);
            try {
                fail(exchange, 500, "INTERNAL", "unexpected bridge failure");
            } catch (IOException ignored) {
                // The socket is already gone.
            }
        }
    }

    private void handleLogin(HttpExchange exchange, String origin, boolean allowedOrigin)
            throws IOException {
        if (origin == null || origin.isBlank()) {
            fail(exchange, 403, "ORIGIN_REQUIRED", "browser requests must carry an Origin header");
            return;
        }
        if (!allowedOrigin) {
            logger.accept("rejected login from disallowed origin " + origin);
            fail(exchange, 403, "ORIGIN_NOT_ALLOWED", "origin is not on the allowlist");
            return;
        }

        drainBody(exchange);

        if (!consumeRateLimit(origin)) {
            exchange.getResponseHeaders().set("Retry-After", "60");
            fail(exchange, 429, "RATE_LIMITED", "too many login attempts from this origin");
            return;
        }

        Duration timeout = config.approvalTimeout();
        boolean approved;
        try {
            approved = gate.approve(origin, timeout);
        } catch (RuntimeException gateFailure) {
            logger.accept("approval gate failed: " + gateFailure);
            fail(exchange, 500, "APPROVAL_FAILED", "could not ask the player for approval");
            return;
        }

        if (!approved) {
            logger.accept("player denied login for " + origin);
            fail(exchange, 403, "APPROVAL_DENIED", "the player denied this login");
            return;
        }

        TokenResponse token;
        try {
            token = minter.mint();
        } catch (Exception mintFailure) {
            // Never leak the underlying Mojang/auth-server detail to the page.
            logger.accept("mint failed for " + origin + ": " + mintFailure);
            fail(exchange, 500, "MINT_FAILED", "the game could not complete the login");
            return;
        }

        logger.accept("issued a token to " + origin + " for " + token.profile().username());
        respondJson(exchange, 200, Json.object(
                "accessToken", token.accessToken(),
                "refreshToken", token.refreshToken(),
                "tokenType", token.tokenType(),
                "expiresIn", token.expiresIn(),
                "profile", Json.object(
                        "uuid", token.profile().uuid(),
                        "username", token.profile().username()),
                "scopes", token.scopes()));
    }

    /** Fixed-window counter per origin; cheap and good enough for a localhost bridge. */
    private boolean consumeRateLimit(String origin) {
        long now = System.currentTimeMillis();
        long windowStart = now - 60_000L;
        Deque<Long> stamps = requestLog.computeIfAbsent(origin, key -> new ArrayDeque<>());
        synchronized (stamps) {
            while (!stamps.isEmpty() && stamps.peekFirst() < windowStart) stamps.pollFirst();
            if (stamps.size() >= config.maxLoginsPerMinute()) return false;
            stamps.addLast(now);
            return true;
        }
    }

    private void drainBody(HttpExchange exchange) throws IOException {
        try (InputStream body = exchange.getRequestBody()) {
            byte[] buffer = new byte[1024];
            int total = 0;
            int read;
            while ((read = body.read(buffer)) != -1) {
                total += read;
                if (total > MAX_BODY_BYTES) break;
            }
        }
    }

    /** Defeats DNS rebinding: an attacker-controlled hostname resolving to 127.0.0.1 sends its own Host. */
    private boolean hostIsLoopback(String hostHeader) {
        if (hostHeader == null || hostHeader.isBlank()) return false;
        String host = hostHeader.toLowerCase(Locale.ROOT);
        int colon = host.lastIndexOf(':');
        if (colon > 0 && host.indexOf(']') < colon) host = host.substring(0, colon);
        host = host.replace("[", "").replace("]", "");
        return "127.0.0.1".equals(host) || "localhost".equals(host) || "::1".equals(host);
    }

    private void writeCommonHeaders(HttpExchange exchange, String allowedOrigin) {
        Headers headers = exchange.getResponseHeaders();
        headers.set("Content-Type", "application/json; charset=utf-8");
        headers.set("Cache-Control", "no-store");
        headers.set("X-Content-Type-Options", "nosniff");
        headers.set("Vary", "Origin");

        if (allowedOrigin != null) {
            headers.set("Access-Control-Allow-Origin", allowedOrigin);
            headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            headers.set("Access-Control-Allow-Headers", "content-type");
            headers.set("Access-Control-Max-Age", "600");
            if (config.allowPrivateNetwork()) {
                // Chromium Private Network Access: required for a public page to reach 127.0.0.1.
                headers.set("Access-Control-Allow-Private-Network", "true");
            }
        }
    }

    private void respondJson(HttpExchange exchange, int status, Map<String, Object> body)
            throws IOException {
        byte[] bytes = Json.write(body).getBytes(StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        } finally {
            exchange.close();
        }
    }

    private void fail(HttpExchange exchange, int status, String code, String message)
            throws IOException {
        Map<String, Object> error = new LinkedHashMap<>();
        error.put("code", code);
        error.put("message", message);
        respondJson(exchange, status, Json.object("error", error));
    }

    /** Endpoints this bridge exposes — handy for docs and tests. */
    public static Set<String> endpoints() {
        return Set.of("GET /v1/health", "POST /v1/login", "OPTIONS *");
    }

    /** Never expose tokens through a stray toString in game logs. */
    @Override
    public String toString() {
        return "LocalAuthBridge[port=" + port() + ", origins=" + List.copyOf(config.allowedOrigins()) + "]";
    }
}
