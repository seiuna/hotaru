package com.skymatrix.irc;

/**
 * Supplies the bearer token used for the WebSocket upgrade.
 *
 * <p>The SDK never obtains tokens itself: that is the auth library's job
 * ({@code com.skymatrix.mcauth.McAuthClient}) or the host's session store. It only
 * asks for a token, and tells you when the server rejected the one it was given.
 *
 * <pre>{@code
 * TokenProvider tokens = new TokenProvider() {
 *     public String accessToken() { return session.accessToken(); }
 *     public void onTokenRejected() { session.refreshNow(); }
 * };
 * }</pre>
 */
@FunctionalInterface
public interface TokenProvider {

    /** Current access token (JWT). Called on every connect/reconnect attempt. */
    String accessToken();

    /**
     * Called when the server answered 401/403 during the upgrade, so the host can
     * refresh. The client retries once with whatever {@link #accessToken()} returns
     * afterwards.
     */
    default void onTokenRejected() {
        // Optional.
    }
}
