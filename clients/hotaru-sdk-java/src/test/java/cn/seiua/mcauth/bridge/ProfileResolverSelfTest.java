package cn.seiua.mcauth.bridge;

import cn.seiua.mcauth.ApiErrorCode;
import cn.seiua.mcauth.McAuthClient;
import cn.seiua.mcauth.McAuthException;
import cn.seiua.mcauth.MinecraftProfileResolver;
import cn.seiua.mcauth.PlayerProfile;
import cn.seiua.json.Json;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;

/**
 * Self-test for token-only identity resolution: {@link MinecraftProfileResolver} plus the
 * {@code McAuthClient.authenticate(AccessTokenProvider)} path.
 *
 * <p>Runs entirely offline against a local mock of {@code api.minecraftservices.com}, which is what a
 * host application would otherwise have to call itself.
 *
 * <p>Run: {@code java -cp out cn.seiua.mcauth.bridge.ProfileResolverSelfTest}
 */
public final class ProfileResolverSelfTest {

    private static final String GOOD_TOKEN = "good-token";
    /** Mojang answers with an uppercase, dashed id; the library must normalise it. */
    private static final String MOJANG_UUID = "4C1099DF-E202-4E64-9EA2-9039BE420143";
    private static final String EXPECTED_UUID = "4c1099dfe2024e649ea29039be420143";

    private static int checks;
    private static int failures;

    public static void main(String[] args) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 4);
        server.createContext("/profile", ProfileResolverSelfTest::handle);
        server.start();
        String endpoint = "http://127.0.0.1:" + server.getAddress().getPort() + "/profile";

        try {
            MinecraftProfileResolver resolver = new MinecraftProfileResolver(endpoint);

            PlayerProfile profile = resolver.resolve(GOOD_TOKEN);
            check("resolves the player from the token", profile.username().equals("yuuiyi"), profile.username());
            check("normalises the UUID to undashed lowercase hex", profile.uuid().equals(EXPECTED_UUID), profile.uuid());

            expectFailure("blank token is rejected before any network call",
                    () -> resolver.resolve("   "), ApiErrorCode.UNAUTHORIZED, false);
            expectFailure("Mojang 401 maps to UNAUTHORIZED",
                    () -> resolver.resolve("expired"), ApiErrorCode.UNAUTHORIZED, false);
            expectFailure("Mojang 5xx maps to a retryable TRANSPORT_ERROR",
                    () -> resolver.resolve("outage"), ApiErrorCode.TRANSPORT_ERROR, true);
            expectFailure("payload without id/name maps to INVALID_RESPONSE",
                    () -> resolver.resolve("weird"), ApiErrorCode.INVALID_RESPONSE, false);

            McAuthClient client = McAuthClient.builder("http://127.0.0.1:9")
                    .profileEndpoint(endpoint)
                    .build();
            check("client.resolveProfile delegates to the resolver",
                    client.resolveProfile(GOOD_TOKEN).uuid().equals(EXPECTED_UUID));

            // Token-only login: the profile lookup must succeed (local mock) and the flow must then
            // fail at the unreachable auth base — proving identity resolution happens first and needs
            // nothing from the caller but a token.
            try {
                client.authenticate(() -> GOOD_TOKEN);
                check("token-only login fails at the dead auth base, not at identity resolution", false,
                        "expected a transport failure");
            } catch (McAuthException expected) {
                check("token-only login resolves identity first, then calls the auth server",
                        expected.errorCode().equals(ApiErrorCode.TRANSPORT_ERROR)
                                || expected.errorCode().startsWith(ApiErrorCode.HTTP_PREFIX),
                        expected.errorCode());
            }
        } finally {
            server.stop(0);
        }

        System.out.println();
        System.out.println("checks passed: " + (checks - failures) + ", failed: " + failures);
        if (failures > 0) {
            System.out.println("RESULT: FAIL");
            System.exit(1);
        }
        System.out.println("RESULT: PASS");
    }

    private static void handle(HttpExchange exchange) throws IOException {
        String authorization = exchange.getRequestHeaders().getFirst("Authorization");
        String token = authorization == null ? "" : authorization.replace("Bearer ", "").trim();

        int status;
        String body;
        switch (token) {
            case GOOD_TOKEN -> {
                status = 200;
                body = Json.write(Json.object("id", MOJANG_UUID, "name", "yuuiyi"));
            }
            case "expired" -> {
                status = 401;
                body = "{\"error\":\"unauthorized\"}";
            }
            case "outage" -> {
                status = 503;
                body = "{\"error\":\"unavailable\"}";
            }
            default -> {
                status = 200;
                body = "{\"unexpected\":true}";
            }
        }

        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        } finally {
            exchange.close();
        }
    }

    @FunctionalInterface
    interface ThrowingCall {
        void run() throws Exception;
    }

    private static void expectFailure(
            String name, ThrowingCall call, String expectedCode, boolean expectedRetryable) {
        try {
            call.run();
            check(name, false, "no exception");
        } catch (McAuthException failure) {
            check(name,
                    expectedCode.equals(failure.errorCode()) && failure.retryable() == expectedRetryable,
                    "code=" + failure.errorCode() + " retryable=" + failure.retryable());
        } catch (Exception unexpected) {
            check(name, false, unexpected.getClass().getSimpleName());
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
