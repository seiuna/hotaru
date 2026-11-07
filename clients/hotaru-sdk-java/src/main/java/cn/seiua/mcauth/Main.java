package cn.seiua.mcauth;

import java.time.Duration;

/**
 * Runnable demo for the SDK.
 *
 * <p>With no arguments it prints the whole flow using placeholder values and performs
 * <strong>no network I/O at all</strong> 鈥?this is what a build or CI run sees. Real calls happen only
 * when endpoints and credentials are passed explicitly:
 *
 * <pre>
 * java -cp out cn.seiua.mcauth.Main
 * java -cp out cn.seiua.mcauth.Main &lt;baseUrl&gt; &lt;username&gt;
 * java -cp out cn.seiua.mcauth.Main &lt;baseUrl&gt; &lt;username&gt; &lt;minecraftAccessToken&gt; &lt;playerUuid&gt;
 * </pre>
 */
public final class Main {

    private static final String PLACEHOLDER_BASE_URL = "https://auth.hotaru.example";
    private static final String PLACEHOLDER_USERNAME = "Notch";
    private static final String PLACEHOLDER_UUID = "069a79f4-44e9-4726-a5be-fca90e38aaf5";

    private Main() {
        // Demo entry point only.
    }

    public static void main(String[] args) {
        if (args.length == 0) {
            printDemo();
            return;
        }
        if ("--help".equals(args[0]) || "-h".equals(args[0])) {
            printUsage();
            return;
        }
        try {
            int exitCode = run(args);
            if (exitCode != 0) System.exit(exitCode);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            System.err.println("interrupted while waiting for the server");
            System.exit(130);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Offline demo (default)                                              */
    /* ------------------------------------------------------------------ */

    private static void printDemo() {
        System.out.println("MC Auth Platform - Fabric Java SDK demo");
        System.out.println("(placeholder values; no network request is made in this mode)");
        System.out.println();

        System.out.println("1. Configure a client");
        System.out.println("     McAuthClient client = McAuthClient.builder(\"" + PLACEHOLDER_BASE_URL + "\")");
        System.out.println("             .connectTimeout(Duration.ofSeconds(5))");
        System.out.println("             .requestTimeout(Duration.ofSeconds(10))");
        System.out.println("             .build();");
        System.out.println();

        System.out.println("2. Ask for a challenge");
        System.out.println("     POST " + PLACEHOLDER_BASE_URL + McAuthClient.DEFAULT_CHALLENGE_PATH);
        System.out.println("     {\"username\":\"" + PLACEHOLDER_USERNAME + "\",\"client\":\"fabric\"}");
        System.out.println("     <- {\"challengeId\":\"<uuid>\",\"serverId\":\"<random salt>\",");
        System.out.println("         \"publicKey\":\"<Base64 DER of the server RSA key>\",");
        System.out.println("         \"verifyToken\":\"<Base64 of 4 random bytes>\",\"expiresIn\":120}");
        System.out.println();

        System.out.println("3. Finish the vanilla handshake locally");
        System.out.println("     sharedSecret = 16 random bytes");
        System.out.println("     encryptedSharedSecret = RSA/PKCS#1 v1.5(publicKey, sharedSecret)   -> Base64");
        System.out.println("     encryptedVerifyToken  = RSA/PKCS#1 v1.5(publicKey, verifyToken)    -> Base64");
        System.out.println("     serverHash = sha1(serverId ASCII || sharedSecret || publicKeyDer)");
        System.out.println("                  as a signed 160-bit integer in lowercase hex");
        System.out.println();

        System.out.println("4. Tell Mojang about the join  (the ONLY request that carries the Mojang token)");
        System.out.println("     POST " + McAuthClient.DEFAULT_MOJANG_SESSION_SERVER + "/session/minecraft/join");
        System.out.println("     {\"accessToken\":\"<mojang access token>\",");
        System.out.println("      \"selectedProfile\":\"" + PLACEHOLDER_UUID.replace("-", "") + "\",");
        System.out.println("      \"serverId\":\"" + "<serverHash>" + "\"}");
        System.out.println("     <- HTTP 204 No Content");
        System.out.println();

        System.out.println("5. Let the MC Auth server verify the session with Mojang");
        System.out.println("     POST " + PLACEHOLDER_BASE_URL + McAuthClient.DEFAULT_VERIFY_PATH);
        System.out.println("     {\"challengeId\":\"<uuid>\",\"username\":\"" + PLACEHOLDER_USERNAME + "\",");
        System.out.println("      \"encryptedSharedSecret\":\"<Base64 ciphertext>\",");
        System.out.println("      \"encryptedVerifyToken\":\"<Base64 ciphertext>\"}");
        System.out.println("     <- {\"accessToken\":\"<Ed25519 JWT>\",\"refreshToken\":\"<rotating token>\",");
        System.out.println("         \"tokenType\":\"Bearer\",\"expiresIn\":900,");
        System.out.println("         \"profile\":{\"uuid\":\"" + PLACEHOLDER_UUID + "\",\"username\":\"" + PLACEHOLDER_USERNAME + "\"},");
        System.out.println("         \"scopes\":[\"hotaru:profile\",\"hotaru:resource\"]}");
        System.out.println();

        System.out.println("6. The call site is one line - implement AccessTokenProvider (one method)");
        System.out.println("     AccessTokenProvider provider = () -> session.accessToken();");
        System.out.println("     TokenResponse tokens = client.authenticate(provider);");
        System.out.println("     // later, without another Mojang join:");
        System.out.println("     TokenResponse rotated = client.refresh(tokens.refreshToken());");
        System.out.println();

        System.out.println("Nothing was sent. Run with real arguments to exercise the flow:");
        System.out.println("     java -cp out cn.seiua.mcauth.Main " + PLACEHOLDER_BASE_URL + " " + PLACEHOLDER_USERNAME);
        System.out.println("     java -cp out cn.seiua.mcauth.Main " + PLACEHOLDER_BASE_URL + " "
                + PLACEHOLDER_USERNAME + " <minecraftAccessToken> " + PLACEHOLDER_UUID);
    }

    /* ------------------------------------------------------------------ */
    /* Live runs (explicit arguments only)                                 */
    /* ------------------------------------------------------------------ */

    private static int run(String[] args) throws InterruptedException {
        if (args.length != 2 && args.length != 4) {
            printUsage();
            return 2;
        }

        McAuthClient client = McAuthClient.builder(args[0])
                .connectTimeout(Duration.ofSeconds(5))
                .requestTimeout(Duration.ofSeconds(15))
                .build();
        String username = args[1];

        try {
            if (args.length == 2) {
                ChallengeResponse challenge = client.requestChallenge(username);
                System.out.println("challenge received");
                System.out.println("  challengeId : " + challenge.challengeId());
                System.out.println("  serverId    : " + challenge.serverId());
                System.out.println("  publicKey   : " + abbreviate(challenge.publicKeyBase64()) + " ("
                        + challenge.publicKeyDer().length + " DER bytes)");
                System.out.println("  verifyToken : " + abbreviate(challenge.verifyTokenBase64()) + " ("
                        + challenge.verifyToken().length + " raw bytes)");
                System.out.println("  expiresIn   : " + challenge.expiresIn() + "s");
                return 0;
            }

            TokenResponse tokens = client.authenticate(args[2], args[3], username);
            System.out.println("authenticated");
            System.out.println("  profile   : " + tokens.profile().username() + " / " + tokens.profile().uuid());
            System.out.println("  tokenType : " + tokens.tokenType() + ", expiresIn " + tokens.expiresIn() + "s");
            System.out.println("  scopes    : " + tokens.scopes());
            System.out.println("  headers   : Authorization: " + abbreviate(tokens.authorizationHeader()));
            System.out.println("  tokens are redacted by TokenResponse#toString(); persist refreshToken yourself");
            return 0;
        } catch (McAuthException e) {
            System.err.println("authentication failed");
            System.err.println("  code      : " + e.errorCode());
            System.err.println("  httpStatus: " + (e.httpStatus() == 0 ? "(no response)" : String.valueOf(e.httpStatus())));
            System.err.println("  retryable : " + e.retryable());
            System.err.println("  message   : " + e.getMessage());
            return 1;
        }
    }

    private static String abbreviate(String value) {
        if (value == null) return "<null>";
        return value.length() <= 24 ? value : value.substring(0, 24) + "...";
    }

    private static void printUsage() {
        System.out.println("Usage:");
        System.out.println("  java -cp out cn.seiua.mcauth.Main");
        System.out.println("        print the flow with placeholders (no network)");
        System.out.println("  java -cp out cn.seiua.mcauth.Main <baseUrl> <username>");
        System.out.println("        request one challenge from a live server (no token needed)");
        System.out.println("  java -cp out cn.seiua.mcauth.Main <baseUrl> <username> <minecraftAccessToken> <playerUuid>");
        System.out.println("        run the full Mojang join + verify flow");
    }
}
