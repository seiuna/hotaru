package com.skymatrix.mcauth;

/**
 * Optional richer variant of {@link AccessTokenProvider}: supply the token <em>and</em> the identity you
 * already have, and the library skips the extra Mojang profile lookup.
 *
 * <p>The library has no Minecraft dependency; a game client, a launcher or a CLI all implement this the
 * same way — three strings. Example implementations live outside the library, in
 * {@code examples/fabric-mod/}.
 *
 * <p><strong>Security:</strong> {@link #accessToken()} returns a Mojang credential. It is handed only to
 * Mojang; it is never sent to the MC Auth server, logged, or persisted by this library. The UUID and
 * username are hints used for the join payload — the server re-derives identity from Mojang and ignores
 * whatever the client claims.
 *
 * <p>Implementations must be cheap and side-effect free — the library may call the getters more than
 * once.
 */
public interface SessionProvider extends AccessTokenProvider {

    /** The player's UUID, dashed or undashed; the library normalises it for the Mojang join payload. */
    String playerUuid();

    /** The player's current Minecraft username (3-16 chars of {@code [A-Za-z0-9_]}). */
    String username();
}
