package cn.seiua.mcauth.bridge;

import cn.seiua.mcauth.TokenResponse;

/**
 * Performs the actual Minecraft handshake and returns a fresh token pair.
 *
 * <p>In a Fabric mod this is typically:
 *
 * <pre>{@code
 * TokenMinter minter = () -> authClient.authenticate(() -> session.accessToken());
 * }</pre>
 *
 * <p>Each call performs a full join/hasJoined round trip (the challenge is single-use), so the bridge
 * rate-limits how often it may be invoked.
 */
@FunctionalInterface
public interface TokenMinter {

    TokenResponse mint() throws Exception;
}
