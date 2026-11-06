package cn.seiua.irc;

/**
 * Server's {@code READY} frame.
 *
 * @param connectionId server-side id of this socket (a player can have several)
 * @param userId internal user id from the token's {@code sub}
 * @param minecraftUuid the player's Mojang UUID, as attested by the server
 * @param instanceId the IRC node that owns this connection
 * @param heartbeatIntervalMs how often the server pings the socket
 * @param serverTime server clock at the moment of the handshake
 */
public record Ready(
        String connectionId,
        String userId,
        String minecraftUuid,
        String instanceId,
        long heartbeatIntervalMs,
        long serverTime) {
}
