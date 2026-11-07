package cn.seiua.mcauth;

import cn.seiua.json.Json;

import java.io.IOException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Pattern;

/**
 * Dependency-free client for the MC Auth Platform's Minecraft authentication flow.
 *
 * <p>Typical usage — one call, on a background thread, with a token your application already has. The
 * library has <strong>no Minecraft or Fabric dependency</strong>: you implement {@link AccessTokenProvider}
 * (one method) and it resolves the identity itself, or {@link SessionProvider} if you already know the
 * UUID and username.
 *
 * <pre>{@code
 * McAuthClient client = McAuthClient.builder("https://auth.hotaru.example")
 *         .connectTimeout(Duration.ofSeconds(5))
 *         .requestTimeout(Duration.ofSeconds(10))
 *         .build();
 *
 * TokenResponse tokens = client.authenticate(() -> sessionStore.accessToken());   // token only
 * // later, without a new Mojang join:
 * TokenResponse rotated = client.refresh(tokens.refreshToken());
 * // on logout:
 * client.logout(rotated.accessToken());
 * }</pre>
 *
 * <p>{@link #authenticate(String, String, String)} runs the exact vanilla handshake the server
 * expects:
 *
 * <ol>
 *   <li>{@code POST /api/v1/auth/minecraft/challenge} → a one-time {@link ChallengeResponse};
 *   <li>16 random shared-secret bytes, RSA/PKCS#1 v1.5 encrypted with the server's public key;
 *   <li>the challenge's verify token (4 raw bytes), RSA/PKCS#1 v1.5 encrypted the same way;
 *   <li>the Minecraft server hash: {@code sha1(serverId || sharedSecret || publicKeyDer)} as signed
 *       lowercase hex ({@link MinecraftServerHash});
 *   <li>{@code POST https://sessionserver.mojang.com/session/minecraft/join} with the player's
 *       <em>Mojang</em> access token, the undashed UUID and that hash — this is the only place the
 *       Mojang token is ever sent;
 *   <li>{@code POST /api/v1/auth/minecraft/verify} with the challenge id, username and the two
 *       ciphertexts → {@link TokenResponse}.
 * </ol>
 *
 * <p><strong>Security model.</strong> The Mojang access token goes to Mojang and nowhere else; the MC
 * Auth server only ever learns the hash, the encrypted blobs and the username, and it proves identity
 * by calling Mojang's {@code hasJoined} itself ({@code NOT_A_PREMIUM_SESSION} when that fails). The
 * server derives the player's UUID and scopes from Mojang/MongoDB, so whatever {@code playerUuid} the
 * client passes is used locally for the join payload only.
 *
 * <p><strong>Threading.</strong> Methods block on the HTTP exchange and are safe to call from any
 * thread, but must never run on a game/UI thread — use a
 * {@code CompletableFuture.supplyAsync(...)} on your own executor. Instances are immutable and
 * thread-safe.
 *
 * <p><strong>Timeouts.</strong> A connect timeout on the {@link HttpClient} and a per-request timeout
 * on every {@link HttpRequest}; both are configurable on the {@link Builder}. On expiry the call fails
 * with {@link ApiErrorCode#TRANSPORT_ERROR} and {@code retryable == true}.
 */
public final class McAuthClient {

    /** Public Mojang session server; overridable for tests. */
    public static final String DEFAULT_MOJANG_SESSION_SERVER = "https://sessionserver.mojang.com";

    /** {@code POST} — create a challenge for a username. */
    public static final String DEFAULT_CHALLENGE_PATH = "/api/v1/auth/minecraft/challenge";

    /** {@code POST} — complete the handshake and receive the token pair. */
    public static final String DEFAULT_VERIFY_PATH = "/api/v1/auth/minecraft/verify";

    /** {@code POST} — rotate a refresh token. */
    public static final String DEFAULT_REFRESH_PATH = "/api/v1/auth/refresh";

    /** {@code POST} — revoke the current session. */
    public static final String DEFAULT_LOGOUT_PATH = "/api/v1/auth/logout";

    /** Sent as {@code User-Agent}; identifies this SDK in server logs. */
    public static final String USER_AGENT = "hotaru-mcauth-java/0.1.0";

    private static final Pattern USERNAME = Pattern.compile("[A-Za-z0-9_]{3,16}");
    private static final Pattern UUID_HEX = Pattern.compile("[0-9a-fA-F]{32}");

    private final URI baseUri;
    private final HttpClient http;
    private final Duration requestTimeout;
    private final URI mojangJoinUri;
    private final SecureRandom random;

    private final String challengePath;
    private final String verifyPath;
    private final String refreshPath;
    private final String logoutPath;
    private final MinecraftProfileResolver profileResolver;

    private McAuthClient(Builder builder) {
        this.baseUri = normalizeBaseUri(builder.baseUrl);
        this.requestTimeout = requirePositive(builder.requestTimeout, "requestTimeout");
        this.challengePath = requirePath(builder.challengePath, "challengePath");
        this.verifyPath = requirePath(builder.verifyPath, "verifyPath");
        this.refreshPath = requirePath(builder.refreshPath, "refreshPath");
        this.logoutPath = requirePath(builder.logoutPath, "logoutPath");
        this.mojangJoinUri = normalizeMojangJoinUri(builder.mojangSessionServer);
        this.profileResolver = builder.profileResolver != null
                ? builder.profileResolver
                : new MinecraftProfileResolver();
        this.random = Objects.requireNonNull(builder.random, "random");
        this.http = builder.httpClient != null
                ? builder.httpClient
                : HttpClient.newBuilder()
                        .connectTimeout(requirePositive(builder.connectTimeout, "connectTimeout"))
                        .followRedirects(HttpClient.Redirect.NEVER)
                        .build();
    }

    /** Starts building a client for the MC Auth server at {@code baseUrl}, e.g. {@code https://auth.example.com}. */
    public static Builder builder(String baseUrl) {
        return new Builder(baseUrl);
    }

    /* ------------------------------------------------------------------ */
    /* Public API                                                          */
    /* ------------------------------------------------------------------ */

    /**
     * Creates a one-time challenge for {@code username}.
     *
     * <p>The username is validated locally first (3-16 characters of {@code [A-Za-z0-9_]}); an invalid
     * one fails with {@link ApiErrorCode#INVALID_REQUEST} without touching the network.
     *
     * @throws McAuthException on a protocol error (see {@link ApiErrorCode}) or a transport failure
     * @throws InterruptedException if the calling thread is interrupted while waiting
     */
    public ChallengeResponse requestChallenge(String username) throws McAuthException, InterruptedException {
        requireValidUsername(username);
        Map<String, Object> payload = Json.object("username", username, "client", "fabric");
        HttpResponse<String> response = post(url(challengePath), payload, null, "challenge");
        Map<String, Object> body = requireJsonObject(response, "challenge", 200, 201);
        return ChallengeResponse.fromJson(body, response.statusCode());
    }

    /**
     * Runs the complete authentication flow and returns the server's token pair.
     *
     * @param accessToken the Minecraft access token from the launcher session — sent only to Mojang
     * @param playerUuid the player's UUID, dashed or undashed; only its undashed form is used locally
     * @param username the player's Minecraft username
     * @throws McAuthException with the server's {@code error.code} on any failure, or a local code for
     *     transport/protocol failures
     * @throws InterruptedException if the calling thread is interrupted while waiting
     */
    public TokenResponse authenticate(String accessToken, String playerUuid, String username)
            throws McAuthException, InterruptedException {
        requireNonBlank(accessToken, "accessToken");
        String undashedUuid = undashUuid(playerUuid);
        requireValidUsername(username);

        ChallengeResponse challenge = requestChallenge(username);

        byte[] sharedSecret = HandshakeCrypto.generateSharedSecret(random);
        byte[] publicKeyDer;
        byte[] verifyToken;
        String serverHash;
        try {
            publicKeyDer = challenge.publicKeyDer();
            verifyToken = challenge.verifyToken();
            // The hash binds this challenge (serverId) to this shared secret and this exact public key.
            serverHash = MinecraftServerHash.compute(challenge.serverId(), sharedSecret, publicKeyDer);
        } catch (IllegalArgumentException e) {
            // Not valid Base64, or a non-ASCII serverId: the server broke its own contract.
            throw new McAuthException(
                    ApiErrorCode.INVALID_RESPONSE,
                    "challenge response cannot be used: " + e.getMessage(),
                    0,
                    false,
                    null,
                    e);
        }

        // Both blobs are RSA/PKCS#1 v1.5 ciphertext over the *raw* bytes, Base64-encoded for transport.
        String encryptedSharedSecret = HandshakeCrypto.rsaEncryptBase64(publicKeyDer, sharedSecret);
        String encryptedVerifyToken = HandshakeCrypto.rsaEncryptBase64(publicKeyDer, verifyToken);

        joinMojangSession(accessToken, undashedUuid, serverHash);

        Map<String, Object> payload = Json.object(
                "challengeId", challenge.challengeId(),
                "username", username,
                "encryptedSharedSecret", encryptedSharedSecret,
                "encryptedVerifyToken", encryptedVerifyToken);
        HttpResponse<String> response = post(url(verifyPath), payload, null, "verify");
        Map<String, Object> body = requireJsonObject(response, "verify", 200, 201);
        return TokenResponse.fromJson(body, response.statusCode());
    }

    /**
     * Convenience overload for host applications that already know the identity (e.g. a game client
     * reading its own session): pulls the token, UUID and username from a {@link SessionProvider}.
     *
     * @see #authenticate(String, String, String)
     */
    public TokenResponse authenticate(SessionProvider session) throws McAuthException, InterruptedException {
        Objects.requireNonNull(session, "session");
        return authenticate(session.accessToken(), session.playerUuid(), session.username());
    }

    /**
     * Token-only login: the caller supplies nothing but the access token, and the library resolves the
     * UUID and username from Mojang's profile endpoint first.
     *
     * <p>Prefer {@link #authenticate(SessionProvider)} when the identity is already known — it saves one
     * HTTPS round trip. When the provider happens to be a {@code SessionProvider}, this method delegates
     * to that overload automatically.
     *
     * @throws McAuthException {@code UNAUTHORIZED} if Mojang rejects the token, {@code TRANSPORT_ERROR}
     *     (retryable) if the profile endpoint is unreachable
     */
    public TokenResponse authenticate(AccessTokenProvider provider)
            throws McAuthException, InterruptedException {
        Objects.requireNonNull(provider, "provider");
        if (provider instanceof SessionProvider session) {
            return authenticate(session);
        }
        PlayerProfile profile = resolveProfile(provider.accessToken());
        return authenticate(provider.accessToken(), profile.uuid(), profile.username());
    }

    /**
     * Asks Mojang who the given access token belongs to, without performing a login.
     *
     * <p>Useful for "is this token still valid?" checks in a launcher UI.
     */
    public PlayerProfile resolveProfile(String accessToken) throws McAuthException, InterruptedException {
        requireNonBlank(accessToken, "accessToken");
        return profileResolver.resolve(accessToken);
    }

    /**
     * Rotates a refresh token. The old token is invalidated server-side; the returned
     * {@link TokenResponse#refreshToken()} is the only one that will work next time.
     *
     * @throws McAuthException with {@link ApiErrorCode#REFRESH_REUSED} if a rotated token is replayed
     *     (the server revokes the whole session in that case), or {@link ApiErrorCode#SESSION_REVOKED}
     *     if the session was revoked
     */
    public TokenResponse refresh(String refreshToken) throws McAuthException, InterruptedException {
        requireNonBlank(refreshToken, "refreshToken");
        HttpResponse<String> response = post(
                url(refreshPath), Json.object("refreshToken", refreshToken), null, "refresh");
        Map<String, Object> body = requireJsonObject(response, "refresh", 200, 201);
        return TokenResponse.fromJson(body, response.statusCode());
    }

    /**
     * Revokes the session behind {@code accessToken}. Idempotent from the caller's point of view:
     * a token that is already revoked makes the server answer 401, which this method reports rather
     * than hides, so callers that do not care can catch and drop it.
     */
    public void logout(String accessToken) throws McAuthException, InterruptedException {
        requireNonBlank(accessToken, "accessToken");
        HttpResponse<String> response = post(url(logoutPath), Json.object(), accessToken, "logout");
        int status = response.statusCode();
        if (status == 200 || status == 202 || status == 204) {
            return;
        }
        throw McAuthException.fromHttp(status, response.body());
    }

    /** The normalised base URL this client talks to. */
    public URI baseUri() {
        return baseUri;
    }

    /* ------------------------------------------------------------------ */
    /* HTTP plumbing                                                       */
    /* ------------------------------------------------------------------ */

    private void joinMojangSession(String accessToken, String undashedUuid, String serverHash)
            throws McAuthException, InterruptedException {
        Map<String, Object> payload = Json.object(
                "accessToken", accessToken,
                "selectedProfile", undashedUuid,
                "serverId", serverHash);
        HttpResponse<String> response = post(mojangJoinUri, payload, null, "Mojang session join", requestTimeout);
        int status = response.statusCode();
        if (status == 200 || status == 204) {
            return;
        }
        if (status == 429 || status >= 500) {
            throw new McAuthException(
                    ApiErrorCode.MOJANG_UNAVAILABLE,
                    "Mojang's session server is temporarily unavailable (HTTP " + status
                            + "); request a new challenge and retry",
                    status,
                    true,
                    null,
                    null);
        }
        String snippet = response.body() == null ? "" : response.body().strip();
        if (snippet.length() > 300) snippet = snippet.substring(0, 300) + "...";
        throw new McAuthException(
                ApiErrorCode.MOJANG_JOIN_REJECTED,
                "Mojang rejected the session join with HTTP " + status
                        + (snippet.isEmpty() ? "" : ": " + snippet)
                        + " - the launcher session is probably invalid or expired; restart the game",
                status,
                false,
                null,
                null);
    }

    private HttpResponse<String> post(URI uri, Map<String, Object> payload, String bearerToken, String operation)
            throws McAuthException, InterruptedException {
        return post(uri, payload, bearerToken, operation, requestTimeout);
    }

    private HttpResponse<String> post(
            URI uri,
            Map<String, Object> payload,
            String bearerToken,
            String operation,
            Duration timeout) throws McAuthException, InterruptedException {
        HttpRequest.Builder request = HttpRequest.newBuilder(uri)
                .timeout(timeout)
                .header("content-type", "application/json")
                .header("accept", "application/json")
                .header("user-agent", USER_AGENT)
                .POST(HttpRequest.BodyPublishers.ofString(Json.write(payload), StandardCharsets.UTF_8));
        if (bearerToken != null) {
            request.header("authorization", "Bearer " + bearerToken);
        }
        try {
            return http.send(request.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        } catch (IOException e) {
            // Deliberately no request details beyond host + operation: no tokens in messages.
            throw McAuthException.transport(
                    operation + " request to " + uri.getHost() + " failed: " + e.getClass().getSimpleName()
                            + (e.getMessage() == null ? "" : " (" + e.getMessage() + ")"),
                    e);
        }
    }

    private static Map<String, Object> requireJsonObject(
            HttpResponse<String> response, String operation, int... acceptedStatuses) throws McAuthException {
        int status = response.statusCode();
        for (int accepted : acceptedStatuses) {
            if (status == accepted) {
                String body = response.body();
                if (body == null || body.isBlank()) {
                    throw new McAuthException(
                            ApiErrorCode.INVALID_RESPONSE,
                            operation + " returned HTTP " + status + " with an empty body",
                            status,
                            false,
                            null,
                            null);
                }
                try {
                    return Json.parseObject(body);
                } catch (RuntimeException e) {
                    throw new McAuthException(
                            ApiErrorCode.INVALID_RESPONSE,
                            operation + " returned a body that is not a JSON object: " + e.getMessage(),
                            status,
                            false,
                            null,
                            e);
                }
            }
        }
        throw McAuthException.fromHttp(status, response.body());
    }

    /* ------------------------------------------------------------------ */
    /* Validation helpers                                                  */
    /* ------------------------------------------------------------------ */

    private static void requireValidUsername(String username) throws McAuthException {
        if (username == null || !USERNAME.matcher(username).matches()) {
            throw new McAuthException(
                    ApiErrorCode.INVALID_REQUEST,
                    "username must be 3-16 characters of A-Za-z0-9_",
                    0,
                    false,
                    null,
                    null);
        }
    }

    private static String undashUuid(String playerUuid) throws McAuthException {
        if (playerUuid == null) {
            throw new McAuthException(ApiErrorCode.INVALID_REQUEST, "playerUuid is required", 0, false, null, null);
        }
        String hex = playerUuid.replace("-", "").toLowerCase(java.util.Locale.ROOT);
        if (!UUID_HEX.matcher(hex).matches()) {
            throw new McAuthException(
                    ApiErrorCode.INVALID_REQUEST,
                    "playerUuid must be a 32-hex-digit Minecraft UUID (dashed or undashed)",
                    0,
                    false,
                    null,
                    null);
        }
        return hex;
    }

    private static void requireNonBlank(String value, String what) throws McAuthException {
        if (value == null || value.isBlank()) {
            throw new McAuthException(ApiErrorCode.INVALID_REQUEST, what + " is required", 0, false, null, null);
        }
    }

    private static URI url(URI base, String path) {
        return URI.create(base.toString() + path);
    }

    private URI url(String path) {
        return url(baseUri, path);
    }

    private static Duration requirePositive(Duration value, String name) {
        Objects.requireNonNull(value, name);
        if (value.isZero() || value.isNegative()) {
            throw new IllegalArgumentException(name + " must be positive, got " + value);
        }
        return value;
    }

    private static String requirePath(String path, String name) {
        Objects.requireNonNull(path, name);
        if (!path.startsWith("/")) {
            throw new IllegalArgumentException(name + " must start with '/', got " + path);
        }
        return path;
    }

    private static URI normalizeBaseUri(String baseUrl) {
        Objects.requireNonNull(baseUrl, "baseUrl");
        String trimmed = baseUrl.strip();
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        if (trimmed.isEmpty()) {
            throw new IllegalArgumentException("baseUrl is empty");
        }
        try {
            URI uri = new URI(trimmed);
            String scheme = uri.getScheme();
            if (scheme == null || !(scheme.equalsIgnoreCase("https") || scheme.equalsIgnoreCase("http"))) {
                throw new IllegalArgumentException("baseUrl must be an http(s) URL, got " + baseUrl);
            }
            if (uri.getHost() == null) {
                throw new IllegalArgumentException("baseUrl has no host: " + baseUrl);
            }
            if (uri.getRawQuery() != null || uri.getRawFragment() != null) {
                throw new IllegalArgumentException("baseUrl must not carry a query or fragment: " + baseUrl);
            }
            return uri;
        } catch (URISyntaxException e) {
            throw new IllegalArgumentException("baseUrl is not a valid URI: " + baseUrl, e);
        }
    }

    private static URI normalizeMojangJoinUri(String sessionServer) {
        Objects.requireNonNull(sessionServer, "mojangSessionServer");
        String trimmed = sessionServer.strip();
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        return URI.create(trimmed + "/session/minecraft/join");
    }

    /* ------------------------------------------------------------------ */
    /* Builder                                                             */
    /* ------------------------------------------------------------------ */

    /**
     * Builder for {@link McAuthClient}. Every knob has a production-safe default; endpoints are
     * overridable so the SDK can be pointed at a local server or a Mojang test double.
     */
    public static final class Builder {

        private final String baseUrl;
        private Duration connectTimeout = Duration.ofSeconds(5);
        private Duration requestTimeout = Duration.ofSeconds(10);
        private String mojangSessionServer = DEFAULT_MOJANG_SESSION_SERVER;
        private String challengePath = DEFAULT_CHALLENGE_PATH;
        private String verifyPath = DEFAULT_VERIFY_PATH;
        private String refreshPath = DEFAULT_REFRESH_PATH;
        private String logoutPath = DEFAULT_LOGOUT_PATH;
        private HttpClient httpClient;
        private SecureRandom random = new SecureRandom();
        private MinecraftProfileResolver profileResolver;

        private Builder(String baseUrl) {
            this.baseUrl = baseUrl;
        }

        /** TCP connect timeout for the internal {@link HttpClient} (ignored with a custom client). */
        public Builder connectTimeout(Duration timeout) {
            this.connectTimeout = requirePositive(timeout, "connectTimeout");
            return this;
        }

        /** Per-request timeout, covering the whole exchange (connect + response). */
        public Builder requestTimeout(Duration timeout) {
            this.requestTimeout = requirePositive(timeout, "requestTimeout");
            return this;
        }

        /** Overrides the Mojang session server origin (default {@value McAuthClient#DEFAULT_MOJANG_SESSION_SERVER}). */
        public Builder mojangSessionServer(String sessionServer) {
            this.mojangSessionServer = Objects.requireNonNull(sessionServer, "mojangSessionServer");
            return this;
        }

        /** Overrides the challenge endpoint path (default {@value McAuthClient#DEFAULT_CHALLENGE_PATH}). */
        public Builder challengePath(String path) {
            this.challengePath = requirePath(path, "challengePath");
            return this;
        }

        /** Overrides the verify endpoint path (default {@value McAuthClient#DEFAULT_VERIFY_PATH}). */
        public Builder verifyPath(String path) {
            this.verifyPath = requirePath(path, "verifyPath");
            return this;
        }

        /** Overrides the refresh endpoint path (default {@value McAuthClient#DEFAULT_REFRESH_PATH}). */
        public Builder refreshPath(String path) {
            this.refreshPath = requirePath(path, "refreshPath");
            return this;
        }

        /** Overrides the logout endpoint path (default {@value McAuthClient#DEFAULT_LOGOUT_PATH}). */
        public Builder logoutPath(String path) {
            this.logoutPath = requirePath(path, "logoutPath");
            return this;
        }

        /** Reuses an existing {@link HttpClient} — for a shared executor, proxy or custom TLS setup. */
        public Builder httpClient(HttpClient client) {
            this.httpClient = Objects.requireNonNull(client, "httpClient");
            return this;
        }

        /** Replaces the random source used for the shared secret (tests only). */
        public Builder secureRandom(SecureRandom random) {
            this.random = Objects.requireNonNull(random, "random");
            return this;
        }

        /**
         * Overrides the Mojang profile endpoint used by token-only logins
         * (default {@value MinecraftProfileResolver#DEFAULT_ENDPOINT}).
         */
        public Builder profileEndpoint(String url) {
            this.profileResolver = new MinecraftProfileResolver(url);
            return this;
        }

        /** Replaces the whole profile resolver (shared client, custom timeouts, tests). */
        public Builder profileResolver(MinecraftProfileResolver resolver) {
            this.profileResolver = Objects.requireNonNull(resolver, "profileResolver");
            return this;
        }

        /** Validates the configuration and builds the client. */
        public McAuthClient build() {
            return new McAuthClient(this);
        }
    }
}
