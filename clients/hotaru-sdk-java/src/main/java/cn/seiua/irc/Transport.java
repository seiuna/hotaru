package cn.seiua.irc;

import java.net.URI;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * The socket underneath {@link IrcClient}.
 *
 * <p>An interface (rather than a hard dependency on {@code java.net.http}) because
 * it lets tests drive the whole state machine deterministically — reconnects, ACK
 * correlation, malformed frames — without a listening socket. The production
 * implementation is {@link JdkWebSocketTransport}.
 */
public interface Transport {

    interface Listener {
        /** A complete text frame. */
        void onText(String text);

        /** The peer or the stack closed the socket. */
        void onClosed(int statusCode, String reason);

        /** Transport-level failure (handshake rejected, IO error, …). */
        void onFailure(Throwable error);
    }

    /**
     * Opens the socket. The future completes when the upgrade succeeded; an
     * exceptional completion may carry a {@link java.net.http.WebSocketHandshakeException}
     * whose HTTP status tells the caller whether a retry can help.
     */
    CompletableFuture<Void> connect(URI uri, Map<String, String> headers, Listener listener);

    /** Enqueues one text frame. Callers must check {@link #isOpen()} first. */
    void send(String text);

    /** Closes with a normal WebSocket close code. */
    void close(int statusCode, String reason);

    boolean isOpen();
}
