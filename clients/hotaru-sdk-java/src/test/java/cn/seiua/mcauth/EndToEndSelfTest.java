package cn.seiua.mcauth;

import cn.seiua.json.Json;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import javax.crypto.Cipher;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * End-to-end check of {@link McAuthClient} against a local mock that behaves like the MC Auth server
 * <em>and</em> like Mojang's session server. Everything runs on loopback; no real endpoint is called,
 * no account is needed.
 *
 * <pre>
 * java -cp out cn.seiua.mcauth.EndToEndSelfTest
 * </pre>
 *
 * <p>The mock holds a real RSA-1024 key pair and decrypts the two ciphertexts the client sends, so
 * this proves the client's wire format against an independent implementation:
 *
 * <ul>
 *   <li>the challenge is answered with Base64 DER and a 4-byte Base64 verify token;
 *   <li>both blobs decrypt to exactly the shared secret (16 bytes) and the verify token, i.e. the
 *       raw bytes were encrypted, not the Base64 text;
 *   <li>the hash sent to {@code /session/minecraft/join} equals
 *       {@code sha1(serverId || sharedSecret || publicKeyDer)} recomputed by the mock;
 *   <li>{@code selectedProfile} is the undashed UUID and the Mojang token reaches Mojang only -
 *       the verify request body is asserted to be free of it;
 *   <li>refresh rotates the token pair, logout carries the bearer token, and server errors keep their
 *       code/status/retryable flags.
 * </ul>
 *
 * <p>Exit code {@code 0} when every check passes, {@code 1} otherwise.
 */
public final class EndToEndSelfTest {

    private static int passed;
    private static int failed;

    private EndToEndSelfTest() {
        // Test entry point only.
    }

    public static void main(String[] args) throws Exception {
        System.out.println("MC Auth Java SDK end-to-end test (local mock, no real network)");
        System.out.println("=============================================================");

        MockServer mock = new MockServer();
        try {
            mock.start();
            runHappyPath(mock);
            runErrorPaths(mock);
        } finally {
            mock.stop();
        }

        System.out.println();
        System.out.println("checks passed: " + passed + ", failed: " + failed);
        if (failed > 0) {
            System.out.println("RESULT: FAIL");
            System.exit(1);
        }
        System.out.println("RESULT: PASS");
    }

    /* ------------------------------------------------------------------ */
    /* Happy path                                                          */
    /* ------------------------------------------------------------------ */

    private static void runHappyPath(MockServer mock) throws Exception {
        section("full handshake against the mock server");

        McAuthClient client = McAuthClient.builder(mock.baseUrl())
                .mojangSessionServer(mock.baseUrl())
                .requestTimeout(java.time.Duration.ofSeconds(10))
                .build();

        String accessToken = "mojang-access-token-" + UUID.randomUUID();
        String playerUuid = "069a79f44e944726a5befca90e38aaf5";

        TokenResponse tokens = client.authenticate(accessToken, playerUuid, "Notch");

        check("authenticate returns a Bearer token pair",
                "Bearer".equals(tokens.tokenType()) && tokens.expiresIn() == 900,
                "got tokenType=" + tokens.tokenType() + " expiresIn=" + tokens.expiresIn());
        check("profile comes from the server",
                "069a79f4-44e9-4726-a5be-fca90e38aaf5".equals(tokens.profile().uuid())
                        && "Notch".equals(tokens.profile().username()),
                "got " + tokens.profile());
        check("scopes parsed", tokens.hasScope("hotaru:profile") && tokens.hasScope("hotaru:resource"),
                "got " + tokens.scopes());
        check("access token is the one the server issued", "access-token-1".equals(tokens.accessToken()),
                "got " + tokens.accessToken());
        check("refresh token is the one the server issued", "refresh-token-1".equals(tokens.refreshToken()),
                "got " + tokens.refreshToken());

        check("client encrypted the raw 16-byte shared secret",
                mock.decryptedSharedSecret.get() != null && mock.decryptedSharedSecret.get().length == 16,
                "server decrypted " + describe(mock.decryptedSharedSecret.get()));
        check("client encrypted the raw 4-byte verify token",
                mock.decryptedVerifyToken.get() != null
                        && mock.decryptedVerifyToken.get().length == 4
                        && java.util.Arrays.equals(mock.verifyTokenIssued(), mock.decryptedVerifyToken.get()),
                "server decrypted " + describe(mock.decryptedVerifyToken.get()));
        check("verify request carried the decrypted shared secret's hash",
                mock.hashMatched.get(), "hash mismatch between join and verify");
        check("join used the undashed UUID",
                "069a79f44e944726a5befca90e38aaf5".equals(mock.joinedSelectedProfile.get()),
                "got " + mock.joinedSelectedProfile.get());
        check("join hash is signed lowercase hex",
                mock.joinedServerHash.get() != null && mock.joinedServerHash.get().matches("-?[0-9a-f]{1,40}"),
                "got " + mock.joinedServerHash.get());
        check("the Mojang access token reached Mojang's join",
                accessToken.equals(mock.joinedAccessToken.get()), "token missing from the join request");
        check("the Mojang access token never reached the MC Auth endpoints",
                !mock.sawAccessTokenInAuthCalls.get(),
                "an MC Auth request body contained the Mojang access token");

        TokenResponse rotated = client.refresh(tokens.refreshToken());
        check("refresh rotates the pair",
                "access-token-2".equals(rotated.accessToken()) && "refresh-token-2".equals(rotated.refreshToken()),
                "got " + rotated.accessToken() + " / " + rotated.refreshToken());

        client.logout(rotated.accessToken());
        check("logout sent the bearer token", "Bearer access-token-2".equals(mock.lastAuthorization.get()),
                "got " + mock.lastAuthorization.get());
    }

    /* ------------------------------------------------------------------ */
    /* Error paths                                                         */
    /* ------------------------------------------------------------------ */

    private static void runErrorPaths(MockServer mock) throws Exception {
        section("server error propagation");

        McAuthClient client = McAuthClient.builder(mock.baseUrl())
                .mojangSessionServer(mock.baseUrl())
                .build();

        mock.verifyFailure.set(MockServer.VerifyFailure.CHALLENGE_CONSUMED);
        McAuthException consumed = expectFailure(() -> client.authenticate("tok", "069a79f44e944726a5befca90e38aaf5", "Notch"));
        check("409 surfaces CHALLENGE_CONSUMED", consumed != null
                        && "CHALLENGE_CONSUMED".equals(consumed.errorCode())
                        && consumed.httpStatus() == 409
                        && !consumed.retryable(),
                "got " + consumed);

        mock.verifyFailure.set(MockServer.VerifyFailure.NOT_A_PREMIUM_SESSION);
        McAuthException notPremium = expectFailure(() -> client.authenticate("tok", "069a79f44e944726a5befca90e38aaf5", "Notch"));
        check("401 surfaces NOT_A_PREMIUM_SESSION", notPremium != null
                        && "NOT_A_PREMIUM_SESSION".equals(notPremium.errorCode())
                        && notPremium.httpStatus() == 401,
                "got " + notPremium);

        mock.verifyFailure.set(MockServer.VerifyFailure.MOJANG_UNAVAILABLE);
        McAuthException unavailable = expectFailure(() -> client.authenticate("tok", "069a79f44e944726a5befca90e38aaf5", "Notch"));
        check("503 surfaces MOJANG_UNAVAILABLE as retryable", unavailable != null
                        && "MOJANG_UNAVAILABLE".equals(unavailable.errorCode())
                        && unavailable.retryable(),
                "got " + unavailable);

        mock.verifyFailure.set(MockServer.VerifyFailure.NONE);
        mock.joinFailure.set(true);
        McAuthException joinRejected = expectFailure(() -> client.authenticate("tok", "069a79f44e944726a5befca90e38aaf5", "Notch"));
        check("Mojang join rejection is local, non-retryable, and names Mojang",
                joinRejected != null
                        && ApiErrorCode.MOJANG_JOIN_REJECTED.equals(joinRejected.errorCode())
                        && !joinRejected.retryable()
                        && joinRejected.getMessage().contains("Mojang"),
                "got " + joinRejected);
        mock.joinFailure.set(false);

        McAuthException reused = expectFailure(() -> client.refresh("stale-refresh-token-value"));
        check("401 surfaces REFRESH_REUSED", reused != null
                        && "REFRESH_REUSED".equals(reused.errorCode())
                        && reused.httpStatus() == 401,
                "got " + reused);

        McAuthClient unreachable = McAuthClient.builder("http://127.0.0.1:1")
                .connectTimeout(java.time.Duration.ofSeconds(1))
                .requestTimeout(java.time.Duration.ofSeconds(1))
                .build();
        McAuthException transport = expectFailure(() -> unreachable.requestChallenge("Notch"));
        check("unreachable server surfaces TRANSPORT_ERROR as retryable", transport != null
                        && "TRANSPORT_ERROR".equals(transport.errorCode())
                        && transport.retryable()
                        && transport.httpStatus() == 0,
                "got " + transport);
    }

    /* ------------------------------------------------------------------ */
    /* Mock server                                                         */
    /* ------------------------------------------------------------------ */

    private interface ThrowingCall {
        void run() throws McAuthException, InterruptedException;
    }

    private static McAuthException expectFailure(ThrowingCall call) {
        try {
            call.run();
            return null;
        } catch (McAuthException e) {
            return e;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return null;
        }
    }

    /** A local stand-in for both the MC Auth server and Mojang's session server. */
    private static final class MockServer {

        enum VerifyFailure { NONE, CHALLENGE_CONSUMED, NOT_A_PREMIUM_SESSION, MOJANG_UNAVAILABLE }

        private final SecureRandom random = new SecureRandom();
        private final KeyPair keyPair;
        private final byte[] publicKeyDer;
        private final AtomicReference<VerifyFailure> verifyFailure = new AtomicReference<>(VerifyFailure.NONE);
        private final AtomicBoolean joinFailure = new AtomicBoolean(false);
        private final AtomicInteger issuedTokens = new AtomicInteger();
        private final AtomicInteger verifyCalls = new AtomicInteger();
        private final AtomicReference<String> lastAuthorization = new AtomicReference<>();

        final AtomicReference<String> joinedAccessToken = new AtomicReference<>();
        final AtomicReference<String> joinedSelectedProfile = new AtomicReference<>();
        final AtomicReference<String> joinedServerHash = new AtomicReference<>();
        final AtomicReference<byte[]> decryptedSharedSecret = new AtomicReference<>();
        final AtomicReference<byte[]> decryptedVerifyToken = new AtomicReference<>();
        final AtomicBoolean hashMatched = new AtomicBoolean(false);
        final AtomicBoolean sawAccessTokenInAuthCalls = new AtomicBoolean(false);

        private String serverId;
        private byte[] verifyToken;
        private String challengeId;
        private HttpServer server;

        MockServer() throws Exception {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
            generator.initialize(1024);
            this.keyPair = generator.generateKeyPair();
            this.publicKeyDer = keyPair.getPublic().getEncoded();
        }

        byte[] verifyTokenIssued() {
            return verifyToken;
        }

        String baseUrl() {
            return "http://127.0.0.1:" + server.getAddress().getPort();
        }

        void start() throws IOException {
            server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
            server.createContext("/api/v1/auth/minecraft/challenge", this::handleChallenge);
            server.createContext("/api/v1/auth/minecraft/verify", this::handleVerify);
            server.createContext("/api/v1/auth/refresh", this::handleRefresh);
            server.createContext("/api/v1/auth/logout", this::handleLogout);
            server.createContext("/session/minecraft/join", this::handleMojangJoin);
            server.start();
        }

        void stop() {
            if (server != null) server.stop(0);
        }

        /* -- handlers ---------------------------------------------------- */

        private void handleChallenge(HttpExchange exchange) throws IOException {
            Map<String, Object> body = readJson(exchange);
            String username = body.get("username") instanceof String s ? s : "";
            serverId = randomHex(16);
            verifyToken = new byte[4];
            random.nextBytes(verifyToken);
            challengeId = UUID.randomUUID().toString();

            respond(exchange, 200, Json.object(
                    "challengeId", challengeId,
                    "serverId", serverId,
                    "publicKey", Base64.getEncoder().encodeToString(publicKeyDer),
                    "verifyToken", Base64.getEncoder().encodeToString(verifyToken),
                    "expiresIn", 120,
                    "echoedUsername", username));
        }

        private void handleMojangJoin(HttpExchange exchange) throws IOException {
            Map<String, Object> body = readJson(exchange);
            String accessToken = body.get("accessToken") instanceof String s ? s : "";
            joinedAccessToken.set(accessToken);
            joinedSelectedProfile.set(body.get("selectedProfile") instanceof String s ? s : null);
            joinedServerHash.set(body.get("serverId") instanceof String s ? s : null);

            if (joinFailure.get()) {
                respond(exchange, 403, "{\"error\":\"Forbidden\",\"errorMessage\":\"Invalid token\"}");
                return;
            }
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
        }

        private void handleVerify(HttpExchange exchange) throws IOException {
            verifyCalls.incrementAndGet();
            String raw = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            Map<String, Object> body = Json.parseObject(raw);

            switch (verifyFailure.get()) {
                case CHALLENGE_CONSUMED -> {
                    respond(exchange, 409, """
                            {"error":{"code":"CHALLENGE_CONSUMED","message":"Challenge was already consumed","retryable":false}}""");
                    return;
                }
                case NOT_A_PREMIUM_SESSION -> {
                    respond(exchange, 401, """
                            {"error":{"code":"NOT_A_PREMIUM_SESSION","message":"Mojang did not confirm an active premium session","retryable":false}}""");
                    return;
                }
                case MOJANG_UNAVAILABLE -> {
                    respond(exchange, 503, """
                            {"error":{"code":"MOJANG_UNAVAILABLE","message":"upstream down","retryable":true}}""");
                    return;
                }
                case NONE -> {
                    // Continue with the checks below.
                }
            }

            if (joinedAccessToken.get() != null && raw.contains(joinedAccessToken.get())) {
                sawAccessTokenInAuthCalls.set(true);
            }

            try {
                byte[] sharedSecret = decrypt(Base64.getDecoder().decode(requireString(body, "encryptedSharedSecret")));
                byte[] token = decrypt(Base64.getDecoder().decode(requireString(body, "encryptedVerifyToken")));
                decryptedSharedSecret.set(sharedSecret);
                decryptedVerifyToken.set(token);

                String expectedHash = MinecraftServerHash.compute(serverId, sharedSecret, publicKeyDer);
                hashMatched.set(expectedHash.equals(joinedServerHash.get()));

                String decodedChallengeId = requireString(body, "challengeId");
                String username = requireString(body, "username");
                if (!challengeId.equals(decodedChallengeId) || !"Notch".equals(username)) {
                    respond(exchange, 400, "{\"error\":{\"code\":\"INVALID_REQUEST\",\"message\":\"bad challenge\",\"retryable\":false}}");
                    return;
                }
            } catch (Exception e) {
                respond(exchange, 400, "{\"error\":{\"code\":\"INVALID_REQUEST\",\"message\":\"cannot decrypt\",\"retryable\":false}}");
                return;
            }

            respond(exchange, 200, tokenResponse(issuedTokens.incrementAndGet()));
        }

        private void handleRefresh(HttpExchange exchange) throws IOException {
            Map<String, Object> body = readJson(exchange);
            String token = body.get("refreshToken") instanceof String s ? s : "";
            if (!token.matches("refresh-token-\\d+")) {
                respond(exchange, 401, """
                        {"error":{"code":"REFRESH_REUSED","message":"Refresh token reuse detected; session revoked","retryable":false}}""");
                return;
            }
            respond(exchange, 200, tokenResponse(issuedTokens.incrementAndGet()));
        }

        private void handleLogout(HttpExchange exchange) throws IOException {
            lastAuthorization.set(exchange.getRequestHeaders().getFirst("authorization"));
            readJson(exchange);
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
        }

        /* -- helpers ----------------------------------------------------- */

        private Map<String, Object> tokenResponse(int index) {
            return Json.object(
                    "accessToken", "access-token-" + index,
                    "refreshToken", "refresh-token-" + index,
                    "tokenType", "Bearer",
                    "expiresIn", 900,
                    "profile", Json.object(
                            "uuid", "069a79f4-44e9-4726-a5be-fca90e38aaf5",
                            "username", "Notch"),
                    "scopes", Json.array("hotaru:profile", "hotaru:resource"));
        }

        private byte[] decrypt(byte[] ciphertext) throws Exception {
            Cipher cipher = Cipher.getInstance("RSA/ECB/PKCS1Padding");
            cipher.init(Cipher.DECRYPT_MODE, keyPair.getPrivate());
            return cipher.doFinal(ciphertext);
        }

        private static Map<String, Object> readJson(HttpExchange exchange) throws IOException {
            String raw = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            return raw.isBlank() ? Map.of() : Json.parseObject(raw);
        }

        private static void respond(HttpExchange exchange, int status, String body) throws IOException {
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("content-type", "application/json");
            exchange.sendResponseHeaders(status, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        }

        private static void respond(HttpExchange exchange, int status, Map<String, Object> body) throws IOException {
            respond(exchange, status, Json.write(body));
        }

        private static String requireString(Map<String, Object> body, String key) {
            return body.get(key) instanceof String s ? s : "";
        }

        private String randomHex(int bytes) {
            byte[] buffer = new byte[bytes];
            random.nextBytes(buffer);
            return HexFormat.of().formatHex(buffer);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Assertions                                                          */
    /* ------------------------------------------------------------------ */

    private static void section(String title) {
        System.out.println();
        System.out.println("-- " + title);
    }

    private static void check(String name, boolean condition, String failureDetail) {
        if (condition) {
            passed++;
            System.out.println("PASS  " + name);
        } else {
            failed++;
            System.out.println("FAIL  " + name + " - " + failureDetail);
        }
    }

    private static String describe(byte[] bytes) {
        return bytes == null ? "null" : bytes.length + " bytes";
    }
}
