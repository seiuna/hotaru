package com.skymatrix.mcauth.bridge;

import com.skymatrix.mcauth.McAuthClient;
import com.skymatrix.mcauth.SessionProvider;
import com.skymatrix.mcauth.json.Json;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;

/**
 * Runnable demo of {@link LocalAuthBridge} for integration testing without Minecraft.
 *
 * <p>It reads the player's Mojang session from the environment (as a Fabric mod would read it from
 * {@code MinecraftClient.getSession()}), starts the bridge on a loopback port, prints
 * {@code BRIDGE_PORT=<n>} and then serves until {@code BRIDGE_SECONDS} elapses or the process is killed.
 *
 * <p>The approval gate auto-approves and says so loudly: a real mod must ask the player in game.
 *
 * <pre>
 * TEST_ACCESSTOKEN=... AUTH_BASE=http://127.0.0.1:3000 java -cp out \
 *   com.skymatrix.mcauth.bridge.BridgeDemo
 * </pre>
 */
public final class BridgeDemo {

    private static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();

    public static void main(String[] args) throws Exception {
        String authBase = env("AUTH_BASE", "http://127.0.0.1:3000");
        String mintBase = env("MOJANG_SESSION_SERVER", McAuthClient.DEFAULT_MOJANG_SESSION_SERVER);
        String accessToken = requireEnv("TEST_ACCESSTOKEN");
        int port = Integer.parseInt(env("BRIDGE_PORT", "8765"));
        int seconds = Integer.parseInt(env("BRIDGE_SECONDS", "120"));
        String origins = env("BRIDGE_ORIGINS", "http://localhost:5173,https://admin.example.com");

        // In a mod this comes from MinecraftClient.getSession(); here we ask Mojang who the token is.
        Map<String, Object> profile = fetchProfile(accessToken);
        String uuid = Json.requireString(profile, "id");
        String username = Json.requireString(profile, "name");

        SessionProvider session = new SessionProvider() {
            @Override
            public String accessToken() {
                return accessToken;
            }

            @Override
            public String playerUuid() {
                return uuid;
            }

            @Override
            public String username() {
                return username;
            }
        };

        McAuthClient authClient = McAuthClient.builder(authBase).mojangSessionServer(mintBase).build();
        BridgeConfig config = new BridgeConfig(
                BridgeConfig.LOOPBACK,
                port,
                java.util.Set.of(origins.split(",")),
                Duration.ofSeconds(30),
                5,
                true);

        LocalAuthBridge bridge = LocalAuthBridge.start(
                config,
                () -> authClient.authenticate(session),
                (origin, timeout) -> {
                    System.out.println("[demo] AUTO-APPROVING " + origin
                            + " — a real mod must ask the player in game");
                    return true;
                },
                message -> System.out.println("[bridge] " + message));

        System.out.println("BRIDGE_PORT=" + bridge.port());
        System.out.println("BRIDGE_USER=" + username);
        System.out.flush();

        try {
            Thread.sleep(seconds * 1000L);
        } finally {
            bridge.close();
        }
    }

    private static Map<String, Object> fetchProfile(String accessToken) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create("https://api.minecraftservices.com/minecraft/profile"))
                .timeout(Duration.ofSeconds(15))
                .header("Authorization", "Bearer " + accessToken)
                .GET()
                .build();
        HttpResponse<String> response = HTTP.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (response.statusCode() != 200) {
            throw new IllegalStateException("Mojang profile lookup failed: HTTP " + response.statusCode());
        }
        return Json.parseObject(response.body());
    }

    private static String env(String name, String fallback) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? fallback : value;
    }

    private static String requireEnv(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException("missing environment variable " + name);
        }
        return value;
    }
}
