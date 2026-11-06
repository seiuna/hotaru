package com.skymatrix.mcauth.bridge;

import com.skymatrix.mcauth.McAuthClient;

import java.time.Duration;
import java.util.Set;

/**
 * Runnable demo of {@link LocalAuthBridge} for integration testing without Minecraft.
 *
 * <p>It is deliberately <strong>token-only</strong>: the only input is the player's Minecraft access
 * token, read from the environment. Everything else — UUID, username, handshake — is resolved by the
 * library, which is exactly how a host application uses it.
 *
 * <pre>
 * TEST_ACCESSTOKEN=... AUTH_BASE=http://127.0.0.1:3000 java -cp out \
 *   com.skymatrix.mcauth.bridge.BridgeDemo
 * </pre>
 *
 * <p>Prints {@code BRIDGE_PORT=<n>} and then serves until {@code BRIDGE_SECONDS} elapses or the process
 * is killed. The approval gate auto-approves and says so loudly — a real host must ask the player.
 */
public final class BridgeDemo {

    public static void main(String[] args) throws Exception {
        String authBase = env("AUTH_BASE", "http://127.0.0.1:3000");
        String mintBase = env("MOJANG_SESSION_SERVER", McAuthClient.DEFAULT_MOJANG_SESSION_SERVER);
        String accessToken = requireEnv("TEST_ACCESSTOKEN");
        int port = Integer.parseInt(env("BRIDGE_PORT", "8765"));
        int seconds = Integer.parseInt(env("BRIDGE_SECONDS", "120"));
        String origins = env("BRIDGE_ORIGINS", "http://localhost:5173,https://admin.example.com");

        McAuthClient authClient = McAuthClient.builder(authBase)
                .mojangSessionServer(mintBase)
                // Production hits Mojang's real profile endpoint; tests may point this elsewhere.
                .build();

        BridgeConfig config = new BridgeConfig(
                BridgeConfig.LOOPBACK,
                port,
                Set.of(origins.split(",")),
                Duration.ofSeconds(30),
                5,
                true);

        LocalAuthBridge bridge = LocalAuthBridge.start(
                config,
                // One method: read the token. No Minecraft classes anywhere in this path.
                () -> authClient.authenticate(() -> accessToken),
                (origin, timeout) -> {
                    System.out.println("[demo] AUTO-APPROVING " + origin
                            + " — a real host must ask the player");
                    return true;
                },
                message -> System.out.println("[bridge] " + message));

        System.out.println("BRIDGE_PORT=" + bridge.port());
        System.out.flush();

        try {
            Thread.sleep(seconds * 1000L);
        } finally {
            bridge.close();
        }
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
