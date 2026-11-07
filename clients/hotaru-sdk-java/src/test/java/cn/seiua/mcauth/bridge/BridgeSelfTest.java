package cn.seiua.mcauth.bridge;

import cn.seiua.mcauth.TokenProfile;
import cn.seiua.mcauth.TokenResponse;
import cn.seiua.json.Json;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Self-test for {@link LocalAuthBridge}. No Minecraft, no network, no auth server: it proves the bridge
 * contract (CORS/PNA headers, origin allowlist, Host guard, approval gate, rate limiting, and that the
 * token payload matches the API contract).
 *
 * <p>Run: {@code java -cp out cn.seiua.mcauth.bridge.BridgeSelfTest}
 */
public final class BridgeSelfTest {

    private static final String ALLOWED = "https://admin.example.com";
    private static final String DENIED = "https://evil.example.com";

    private static int checks;
    private static int failures;

    public static void main(String[] args) throws Exception {
        // Needed to send a forged Host header (DNS-rebinding simulation).
        System.setProperty("jdk.httpclient.allowRestrictedHeaders", "host");

        AtomicBoolean approve = new AtomicBoolean(true);
        AtomicReference<String> lastOrigin = new AtomicReference<>();
        BridgeConfig config = new BridgeConfig(
                BridgeConfig.LOOPBACK, 0, Set.of(ALLOWED), Duration.ofSeconds(5), 2, true);

        TokenResponse stubToken = new TokenResponse(
                "access-token-1",
                "refresh-token-1",
                "Bearer",
                900,
                new TokenProfile("4c1099df-e202-4e64-9ea2-9039be420143", "yuuiyi"),
                List.of("hotaru:profile", "admin:users"));

        try (LocalAuthBridge bridge = LocalAuthBridge.start(
                config,
                () -> stubToken,
                (origin, timeout) -> {
                    lastOrigin.set(origin);
                    return approve.get();
                })) {

            String base = "http://127.0.0.1:" + bridge.port();
            HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();

            // 1. health, allowlisted origin
            HttpResponse<String> health = send(client, "GET", base + "/v1/health", ALLOWED, null);
            check("health returns 200", health.statusCode() == 200, "got " + health.statusCode());
            check("health advertises the service",
                    health.body().contains(LocalAuthBridge.SERVICE_NAME), health.body());
            check("health echoes the allowed origin",
                    ALLOWED.equals(header(health, "access-control-allow-origin")),
                    String.valueOf(header(health, "access-control-allow-origin")));
            check("health is not cacheable",
                    "no-store".equals(header(health, "cache-control")), header(health, "cache-control"));

            // 2. health without an Origin (curl / monitoring)
            HttpResponse<String> noOrigin = send(client, "GET", base + "/v1/health", null, null);
            check("health answers without an Origin header", noOrigin.statusCode() == 200,
                    "got " + noOrigin.statusCode());

            // 3. preflight from the allowlisted origin, including Private Network Access
            HttpRequest preflight = HttpRequest.newBuilder(URI.create(base + "/v1/login"))
                    .header("Origin", ALLOWED)
                    .header("Access-Control-Request-Method", "POST")
                    .header("Access-Control-Request-Private-Network", "true")
                    .method("OPTIONS", HttpRequest.BodyPublishers.noBody())
                    .build();
            HttpResponse<String> options = client.send(preflight, HttpResponse.BodyHandlers.ofString());
            check("preflight returns 204", options.statusCode() == 204, "got " + options.statusCode());
            check("preflight advertises POST",
                    String.valueOf(header(options, "access-control-allow-methods")).contains("POST"),
                    header(options, "access-control-allow-methods"));
            check("preflight authorises private network access",
                    "true".equals(header(options, "access-control-allow-private-network")),
                    header(options, "access-control-allow-private-network"));

            // 4. preflight from a foreign origin is refused
            HttpRequest badPreflight = HttpRequest.newBuilder(URI.create(base + "/v1/login"))
                    .header("Origin", DENIED)
                    .header("Access-Control-Request-Method", "POST")
                    .method("OPTIONS", HttpRequest.BodyPublishers.noBody())
                    .build();
            HttpResponse<String> deniedOptions = client.send(badPreflight, HttpResponse.BodyHandlers.ofString());
            check("preflight from a foreign origin is refused", deniedOptions.statusCode() == 403,
                    "got " + deniedOptions.statusCode());

            // 5. login: foreign origin
            HttpResponse<String> foreign = send(client, "POST", base + "/v1/login", DENIED, "");
            check("login from a foreign origin is refused", foreign.statusCode() == 403,
                    "got " + foreign.statusCode());
            check("refusal carries a machine-readable code",
                    errorCode(foreign).equals("ORIGIN_NOT_ALLOWED"), errorCode(foreign));
            check("no allow-origin header leaks to a foreign origin",
                    header(foreign, "access-control-allow-origin") == null,
                    header(foreign, "access-control-allow-origin"));

            // 6. login: allowed origin + approval
            HttpResponse<String> login = send(client, "POST", base + "/v1/login", ALLOWED, "{}");
            check("approved login returns 200", login.statusCode() == 200, "got " + login.statusCode());
            Map<String, Object> token = Json.parseObject(login.body());
            check("token payload carries the access token",
                    "access-token-1".equals(Json.requireString(token, "accessToken")), login.body());
            check("token payload carries the refresh token",
                    "refresh-token-1".equals(Json.requireString(token, "refreshToken")));
            check("token payload carries the profile",
                    "yuuiyi".equals(Json.requireString(Json.requireObject(token, "profile"), "username")));
            check("token payload carries scopes",
                    Json.requireStringArray(token, "scopes").contains("admin:users"));
            check("approval gate saw the exact origin", ALLOWED.equals(lastOrigin.get()),
                    String.valueOf(lastOrigin.get()));
            check("login responses are not cacheable",
                    "no-store".equals(header(login, "cache-control")));

            // 7. login: player denies
            approve.set(false);
            HttpResponse<String> denied = send(client, "POST", base + "/v1/login", ALLOWED, "{}");
            check("denied approval returns 403", denied.statusCode() == 403, "got " + denied.statusCode());
            check("denial code is APPROVAL_DENIED", errorCode(denied).equals("APPROVAL_DENIED"),
                    errorCode(denied));
            check("denial leaks no token", !denied.body().contains("access-token-1"));

            // 8. rate limit (config allows 2 logins/minute; both were just used)
            approve.set(true);
            HttpResponse<String> limited = send(client, "POST", base + "/v1/login", ALLOWED, "{}");
            check("third login within the window is rate limited", limited.statusCode() == 429,
                    "got " + limited.statusCode());
            check("rate limit sets Retry-After", header(limited, "retry-after") != null);

            // 9. DNS rebinding: loopback port reached with a foreign Host header
            HttpRequest rebound = HttpRequest.newBuilder(URI.create(base + "/v1/health"))
                    .header("Origin", ALLOWED)
                    .header("Host", "evil.example.com")
                    .GET()
                    .build();
            HttpResponse<String> reboundResponse = client.send(rebound, HttpResponse.BodyHandlers.ofString());
            check("foreign Host header is refused", reboundResponse.statusCode() == 403,
                    "got " + reboundResponse.statusCode());

            // 10. unknown endpoint
            HttpResponse<String> missing = send(client, "GET", base + "/v1/nope", ALLOWED, null);
            check("unknown endpoint is 404", missing.statusCode() == 404, "got " + missing.statusCode());

            check("bridge reports its bound port", bridge.port() > 0);
            check("bridge exposes exactly three endpoints",
                    LocalAuthBridge.endpoints().size() == 3, LocalAuthBridge.endpoints().toString());
        }

        System.out.println();
        System.out.println("checks passed: " + (checks - failures) + ", failed: " + failures);
        if (failures > 0) {
            System.out.println("RESULT: FAIL");
            System.exit(1);
        }
        System.out.println("RESULT: PASS");
    }

    private static HttpResponse<String> send(
            HttpClient client, String method, String url, String origin, String body) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(10));
        if (origin != null) builder.header("Origin", origin);
        if (body == null) {
            builder.method(method, HttpRequest.BodyPublishers.noBody());
        } else {
            builder.header("Content-Type", "application/json");
            builder.method(method, HttpRequest.BodyPublishers.ofString(body));
        }
        return client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
    }

    private static String header(HttpResponse<?> response, String name) {
        return response.headers().firstValue(name).orElse(null);
    }

    private static String errorCode(HttpResponse<String> response) {
        try {
            return Json.requireString(Json.requireObject(Json.parseObject(response.body()), "error"), "code");
        } catch (RuntimeException ignored) {
            return "<none>";
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
}
