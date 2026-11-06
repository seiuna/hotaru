package cn.seiua.irc;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

/**
 * {@link Transport} built on the JDK's own WebSocket client — no Netty, no
 * OkHttp, no extra jar in the mod.
 *
 * <p>Text frames are reassembled across partial {@code CharSequence}s; the JDK
 * answers WebSocket pings automatically, so the server's heartbeat needs no code.
 */
public final class JdkWebSocketTransport implements Transport {

    private static final int MAX_QUEUED_FRAMES = 256;

    private final Duration connectTimeout;
    private HttpClient client;
    private WebSocket socket;
    private volatile boolean open;

    public JdkWebSocketTransport(Duration connectTimeout) {
        this.connectTimeout = connectTimeout;
    }

    @Override
    public CompletableFuture<Void> connect(URI uri, Map<String, String> headers, Listener listener) {
        this.client = HttpClient.newBuilder()
                .connectTimeout(connectTimeout)
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();

        WebSocket.Builder builder = client.newWebSocketBuilder().connectTimeout(connectTimeout);
        headers.forEach(builder::header);

        FrameListener frameListener = new FrameListener(listener);
        return builder.buildAsync(uri, frameListener).thenApply(webSocket -> {
            this.socket = webSocket;
            this.open = true;
            webSocket.request(1);
            return null;
        });
    }

    @Override
    public void send(String text) {
        WebSocket current = socket;
        if (current == null || !open) throw new IllegalStateException("socket is not open");
        current.sendText(text, true).join();
    }

    @Override
    public void close(int statusCode, String reason) {
        open = false;
        WebSocket current = socket;
        if (current == null) return;
        try {
            current.sendClose(statusCode, reason == null ? "" : reason).join();
        } catch (RuntimeException ignored) {
            // Peer already gone.
        } finally {
            current.abort();
        }
    }

    @Override
    public boolean isOpen() {
        return open;
    }

    /** Reassembles frames and forwards them; never lets an exception escape into the JDK. */
    private static final class FrameListener implements WebSocket.Listener {

        private final Listener listener;
        private final StringBuilder buffer = new StringBuilder();

        FrameListener(Listener listener) {
            this.listener = listener;
        }

        @Override
        public void onOpen(WebSocket webSocket) {
            webSocket.request(1);
        }

        @Override
        public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
            buffer.append(data);
            if (last) {
                String frame = buffer.toString();
                buffer.setLength(0);
                try {
                    listener.onText(frame);
                } catch (RuntimeException ignored) {
                    // A broken handler must not kill the socket.
                }
            }
            webSocket.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
            listener.onClosed(statusCode, reason);
            return null;
        }

        @Override
        public void onError(WebSocket webSocket, Throwable error) {
            listener.onFailure(error);
        }
    }
}
