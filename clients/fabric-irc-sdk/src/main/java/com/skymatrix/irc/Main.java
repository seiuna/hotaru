package com.skymatrix.irc;

import java.time.Duration;
import java.util.List;
import java.util.Map;

/**
 * Offline demo: prints the API and the frames it would send. Running it without
 * arguments performs no network I/O.
 *
 * <pre>
 * javac --release 21 -d out $(find src -name '*.java')
 * java -cp out com.skymatrix.irc.Main
 * </pre>
 */
public final class Main {

    public static void main(String[] args) {
        String baseUrl = args.length > 0 ? args[0] : "https://irc.example.com";

        System.out.println("SkyMatrix Relay Protocol v1 — Java client demo");
        System.out.println("endpoint: " + baseUrl + "/v1/connect");
        System.out.println();
        System.out.println("Typical wiring in a Fabric client mod:");
        System.out.println();
        System.out.println("  IrcClient irc = IrcClient.builder(\"" + baseUrl + "\")");
        System.out.println("          .tokenProvider(() -> session.accessToken())   // MC Auth JWT");
        System.out.println("          .dispatchExecutor(client::execute)             // game thread");
        System.out.println("          .build();");
        System.out.println();
        System.out.println("  irc.on(\"chat.message\", message -> chat.show(message.text()));");
        System.out.println("  irc.on(\"skymatrix.*\", message -> mod.handle(message.type(), message.payload()));");
        System.out.println("  irc.onAck(ack -> log.debug(\"ack {}\", ack));");
        System.out.println("  irc.onError(error -> log.warn(\"irc error {}\", error));");
        System.out.println();
        System.out.println("  irc.connect().join();");
        System.out.println("  irc.sendDirect(targetUuid, \"chat.message\", Map.of(\"text\", \"hello\"));");
        System.out.println("  irc.sendGroup(groupId, \"skymatrix.party.state\", partyState);");
        System.out.println("  irc.close();");
        System.out.println();

        // Show exactly what would go on the wire, without connecting.
        IrcClient probe = IrcClient.builder(baseUrl)
                .tokenProvider(() -> "demo-token-not-used")
                .logger(System.out::println)
                .build();
        try {
            probe.sendDirect("4c1099df-e202-4e64-9ea2-9039be420143", "chat.message", Map.of("text", "hi"));
        } catch (IrcException expected) {
            System.out.println("Expected while offline: " + expected.code() + " — " + expected.getMessage());
        }
        System.out.println("Reconnect policy: " + describe(ReconnectPolicy.defaults()));
        System.out.println();
        System.out.println("Nothing was sent. Pass a real URL with a valid token to exercise the flow.");
    }

    private static String describe(ReconnectPolicy policy) {
        List<Long> delays = List.of(
                policy.delayForAttempt(1),
                policy.delayForAttempt(2),
                policy.delayForAttempt(3));
        return "delays " + delays + " ms, max attempts " + policy.maxAttempts()
                + ", ack timeout " + Duration.ofSeconds(15).toSeconds() + "s";
    }
}
