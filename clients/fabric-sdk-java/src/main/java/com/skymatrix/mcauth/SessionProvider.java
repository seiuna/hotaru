package com.skymatrix.mcauth;

/**
 * Everything the SDK needs to authenticate a player, expressed as three plain strings so that the SDK
 * never has to link against Minecraft classes.
 *
 * <p>A Fabric mod implements this once, on the client, and hands the resulting instance to
 * {@link McAuthClient#authenticate(SessionProvider)}. The canonical Fabric implementation reads the
 * launcher's session:
 *
 * <pre>{@code
 * @Environment(EnvType.CLIENT)
 * public final class FabricSessionProvider implements SessionProvider {
 *     private final MinecraftClient client = MinecraftClient.getInstance();
 *
 *     @Override
 *     public String accessToken() {
 *         return client.getSession().getAccessToken();
 *     }
 *
 *     @Override
 *     public String playerUuid() {
 *         // getSession().getUuid() is already the undashed 32-char hex form.
 *         return client.getSession().getUuid();
 *     }
 *
 *     @Override
 *     public String username() {
 *         return client.getSession().getUsername();
 *     }
 * }
 * }</pre>
 *
 * <p>The full, compilable-looking version — including the {@code FabricClientModInitializer} wiring
 * and the dedicated-server guard — lives in
 * {@code clients/fabric-sdk-java/fabric-example/FabricClientSessionProvider.java.example}. It is
 * deliberately <strong>not</strong> part of the {@code javac} build: Minecraft and Fabric classes are
 * not on the standalone classpath.
 *
 * <p><strong>Security:</strong> {@link #accessToken()} returns a Mojang credential. It is handed only
 * to {@code sessionserver.mojang.com}; it is never sent to the MC Auth server, logged, or persisted by
 * this SDK.
 *
 * <p>Implementations must be cheap and side-effect free — the SDK may call the getters more than once.
 */
public interface SessionProvider {

    /** The Minecraft access token from the launcher session (never leaves the client except to Mojang). */
    String accessToken();

    /** The player's UUID, dashed or undashed; the SDK normalises it for the Mojang join payload. */
    String playerUuid();

    /** The player's current Minecraft username (3-16 chars of {@code [A-Za-z0-9_]}). */
    String username();
}
