package cn.seiua.mcauth;

/**
 * The only thing a host application must supply: a way to read the player's Minecraft access token.
 *
 * <p>This library never talks to Minecraft, Fabric or a launcher. How the token is obtained is the
 * host's business — a game client reads it from its session, a launcher from its profile store, a test
 * from a fixture. Implement the interface and the library does the rest: it resolves the player's
 * identity from Mojang, performs the handshake and returns a token pair.
 *
 * <pre>{@code
 * // Anywhere in your application:
 * AccessTokenProvider provider = () -> mySessionStore.accessToken();
 * TokenResponse tokens = client.authenticate(provider);
 * }</pre>
 *
 * <p><strong>Security:</strong> the token returned here is a Mojang credential. The library sends it
 * only to {@code sessionserver.mojang.com} / {@code api.minecraftservices.com} — never to the MC Auth
 * server, never to a log. Implementations should be cheap and side-effect free: the library may call
 * {@link #accessToken()} more than once per login.
 *
 * @see SessionProvider if you already know the UUID and username and want to skip the profile lookup
 */
@FunctionalInterface
public interface AccessTokenProvider {

    /**
     * The Minecraft access token from the player's session.
     *
     * @return a non-blank token; the library rejects blank values before any network call
     */
    String accessToken();
}
