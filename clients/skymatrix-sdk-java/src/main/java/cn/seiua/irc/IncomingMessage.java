package cn.seiua.irc;

import java.util.Map;

/**
 * A business message delivered by the server.
 *
 * <p>Server-attested fields ({@code senderUuid}, {@code senderUserId},
 * {@code receivedAt}, {@code expireAt}) are added by the relay; a client can never
 * set them, and this SDK never takes the sender from the payload.
 *
 * @param id the sender's message id (use it to de-duplicate; the SDK already does)
 * @param type business type, e.g. {@code chat.message}
 * @param routeMode DIRECT / GROUP / BROADCAST
 * @param routeTarget target UUID or group id (null for broadcast)
 * @param payload the business payload as parsed JSON (maps/lists/strings/numbers)
 * @param senderUuid the sender's Mojang UUID, attested by the server
 * @param senderUserId the sender's internal user id
 * @param receivedAt server receipt time (epoch millis)
 * @param expireAt server-computed absolute expiry (epoch millis)
 */
public record IncomingMessage(
        String id,
        String type,
        String routeMode,
        String routeTarget,
        Object payload,
        String senderUuid,
        String senderUserId,
        long receivedAt,
        long expireAt) {

    /** Convenience accessor for the common chat case; null when the payload has no {@code text}. */
    public String text() {
        if (payload instanceof Map<?, ?> map) {
            Object value = map.get("text");
            return value instanceof String string ? string : null;
        }
        return null;
    }
}
