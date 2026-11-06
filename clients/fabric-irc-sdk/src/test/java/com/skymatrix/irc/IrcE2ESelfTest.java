package com.skymatrix.irc;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

/**
 * End-to-end check of this SDK against a **real** SRP v1 relay: a real WebSocket
 * upgrade, a real JWT minted by the auth server, real routing and ACKs.
 *
 * <p>Requires:
 * <ul>
 *   <li>{@code IRC_URL} — e.g. {@code ws://127.0.0.1:3001/v1/connect}</li>
 *   <li>{@code IRC_TOKEN} — a valid JWT with {@code skymatrix:ircserver}</li>
 * </ul>
 *
 * <pre>java -cp out com.skymatrix.irc.IrcE2ESelfTest</pre>
 */
public final class IrcE2ESelfTest {

    private static int checks;
    private static int failures;

    public static void main(String[] args) throws Exception {
        String url = System.getenv("IRC_URL");
        String token = System.getenv("IRC_TOKEN");
        if (url == null || url.isBlank() || token == null || token.isBlank()) {
            System.out.println("SKIP: set IRC_URL and IRC_TOKEN to run the end-to-end test");
            return;
        }

        IrcClient client = IrcClient.builder(url)
                .tokenProvider(() -> token)
                .dispatchExecutor(Runnable::run)
                .ackTimeout(Duration.ofSeconds(10))
                .logger(message -> { })
                .build();

        List<IncomingMessage> received = new CopyOnWriteArrayList<>();
        List<Ack> acks = new CopyOnWriteArrayList<>();
        List<ProtocolError> errors = new CopyOnWriteArrayList<>();
        client.onMessage(received::add).onAck(acks::add).onError(errors::add);

        try {
            Ready ready = client.connect().get(15, TimeUnit.SECONDS);
            check("real server accepted the upgrade and sent READY", true);
            check("READY carries a server-attested UUID", ready.minecraftUuid().matches("[0-9a-f-]{36}"), ready.minecraftUuid());
            check("READY carries the owning instance", !ready.instanceId().isBlank());
            check("state is CONNECTED", client.state() == IrcState.CONNECTED);

            String selfUuid = ready.minecraftUuid();
            CompletableFuture<Ack> pending = client.sendDirectAsync(
                    selfUuid, "chat.message", Map.of("text", "hello from the java sdk", "seq", 1));

            Ack ack = pending.get(10, TimeUnit.SECONDS);
            check("ACK reaches delivered", ack.isDelivered(), ack.toString());
            check("ACK reports at least one recipient", ack.recipients() >= 1, String.valueOf(ack.recipients()));

            long deadline = System.currentTimeMillis() + 3000;
            while (received.isEmpty() && System.currentTimeMillis() < deadline) {
                Thread.sleep(20);
            }
            check("the message comes back over the wire", !received.isEmpty());
            if (!received.isEmpty()) {
                IncomingMessage message = received.get(0);
                check("type round-trips", "chat.message".equals(message.type()), message.type());
                check("payload round-trips", "hello from the java sdk".equals(message.text()), String.valueOf(message.text()));
                check("route is DIRECT", "DIRECT".equals(message.routeMode()), message.routeMode());
                check("sender is the server-attested identity", selfUuid.equals(message.senderUuid()), message.senderUuid());
                check("server stamped an absolute expiry", message.expireAt() > message.receivedAt());
            }

            client.ping();
            Thread.sleep(150);
            check("no protocol errors on the happy path", errors.isEmpty(), errors.toString());

            IrcClient badToken = IrcClient.builder(url)
                    .tokenProvider(() -> "not-a-jwt")
                    .dispatchExecutor(Runnable::run)
                    .reconnectPolicy(ReconnectPolicy.disabled())
                    .logger(message -> { })
                    .build();
            String code = "";
            try {
                badToken.connect().get(15, TimeUnit.SECONDS);
            } catch (Exception failure) {
                Throwable cause = failure.getCause() == null ? failure : failure.getCause();
                code = cause instanceof IrcException irc ? irc.code() : cause.getClass().getSimpleName();
            }
            check("a forged token is rejected during the upgrade", code.equals("UNAUTHORIZED"), code);
            badToken.close();
        } finally {
            client.close();
        }

        System.out.println();
        System.out.println("checks passed: " + (checks - failures) + ", failed: " + failures);
        if (failures > 0) {
            System.out.println("RESULT: FAIL");
            System.exit(1);
        }
        System.out.println("RESULT: PASS");
    }

    private static void check(String name, boolean condition) {
        check(name, condition, "");
    }

    private static void check(String name, boolean condition, String detail) {
        checks++;
        if (condition) {
            System.out.println("  PASS  " + name);
        } else {
            failures++;
            System.out.println("  FAIL  " + name + (detail.isBlank() ? "" : " -> " + detail));
        }
    }
}
