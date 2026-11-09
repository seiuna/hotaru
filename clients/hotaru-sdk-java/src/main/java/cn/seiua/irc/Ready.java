package cn.seiua.irc;

import java.util.List;

/**
 * Server's {@code READY} frame.
 *
 * @param connectionId server-side id of this socket (a player can have several)
 * @param userId internal user id from the token's {@code sub}
 * @param minecraftUuid the player's Mojang UUID, as attested by the server
 * @param instanceId the IRC node that owns this connection
 * @param heartbeatIntervalMs how often the server pings the socket
 * @param serverTime server clock at the moment of the handshake
 * @param username the player's Minecraft username
 * @param nickname the IRC display name (custom or Minecraft username)
 * @param tags server-attested display tags, e.g. admin/user/dev/vip
 */
public record Ready(
        String connectionId,
        String userId,
        String minecraftUuid,
        String instanceId,
        long heartbeatIntervalMs,
        long serverTime,
        String username,
        String nickname,
        List<String> tags) {

    /** Backward-compatible constructor for callers that only know the v1 fields. */
    public Ready(
            String connectionId,
            String userId,
            String minecraftUuid,
            String instanceId,
            long heartbeatIntervalMs,
            long serverTime) {
        this(connectionId, userId, minecraftUuid, instanceId, heartbeatIntervalMs, serverTime, "", "", List.of());
    }
}
