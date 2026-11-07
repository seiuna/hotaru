package cn.seiua.irc;

/**
 * Thrown by a {@link Transport} when the server refused the WebSocket upgrade.
 *
 * <p>The JDK transport reports {@link java.net.http.WebSocketHandshakeException};
 * custom transports (and tests) use this type so the client can distinguish
 * "token rejected, retry once after refresh" (401/403) from "endpoint missing" (404)
 * and from transient failures.
 */
public class HandshakeRejectedException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    private final int statusCode;

    public HandshakeRejectedException(int statusCode, String message) {
        super(message);
        this.statusCode = statusCode;
    }

    public int statusCode() {
        return statusCode;
    }
}
