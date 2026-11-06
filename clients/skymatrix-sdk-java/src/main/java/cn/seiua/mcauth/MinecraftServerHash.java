package cn.seiua.mcauth;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Objects;

/**
 * The Minecraft "server hash" — the {@code serverId} value exchanged with Mojang, reproduced bit for
 * bit from the vanilla client (and from
 * {@code apps/auth-server/src/infrastructure/crypto/server-hash.ts} on the server side).
 *
 * <p>The algorithm is <em>not</em> {@code sha1(...).hex()}:
 *
 * <ol>
 *   <li>{@code digest = sha1(serverId.getBytes(ASCII) || sharedSecret || publicKeyDer)} — 20 bytes;
 *   <li>reinterpret those 20 bytes as a <strong>signed</strong> 160-bit big-endian two's-complement
 *       integer (so a digest whose first byte is {@code >= 0x80} becomes negative);
 *   <li>print it in lowercase hexadecimal, with a leading {@code '-'} for negative values and
 *       <em>without</em> any zero padding on either side.
 * </ol>
 *
 * <p>Examples:
 *
 * <pre>{@code
 * digest 4715edf2...b5ad1df5  ->  "4715edf2877272abb7d7bd306440753db5ad1df5"
 * digest bdaf5211...7bdfba7a  ->  "-4250adee..."   (negative: leading '-', no leading zeroes)
 * digest 00a10163...81d269cc  ->  "a101634f..."    (leading zero byte is dropped)
 * }</pre>
 *
 * <p>This is exactly what {@code new BigInteger(digest).toString(16)} produces in Java: the
 * {@link BigInteger#BigInteger(byte[])} constructor interprets its argument as a signed
 * two's-complement big-endian integer, and {@link BigInteger#toString(int)} prints the shortest
 * lowercase hex form. The SDK therefore uses that single expression, and
 * {@code ServerHashSelfTest} pins it against vectors produced by the server's TypeScript
 * implementation.
 *
 * <p>Thread-safe and stateless.
 */
public final class MinecraftServerHash {

    /** Size of the SHA-1 digest in bytes (160 bits). */
    public static final int DIGEST_BYTES = 20;

    private MinecraftServerHash() {
        // Static utility class.
    }

    /**
     * Computes the 20-byte SHA-1 digest that the signed-hex encoding is derived from:
     * {@code sha1(serverId ASCII || sharedSecret || publicKeyDer)}.
     *
     * @throws IllegalArgumentException if {@code serverId} is not pure ASCII — the vanilla hash is
     *     defined over the ASCII bytes, and client and server must agree exactly
     */
    public static byte[] digest(String serverId, byte[] sharedSecret, byte[] publicKeyDer) {
        Objects.requireNonNull(serverId, "serverId");
        Objects.requireNonNull(sharedSecret, "sharedSecret");
        Objects.requireNonNull(publicKeyDer, "publicKeyDer");
        MessageDigest sha1;
        try {
            sha1 = MessageDigest.getInstance("SHA-1");
        } catch (NoSuchAlgorithmException e) {
            // Every conformant Java SE platform ships SHA-1.
            throw new IllegalStateException("SHA-1 is unavailable in this JVM", e);
        }
        sha1.update(asciiBytes(serverId));
        sha1.update(sharedSecret);
        sha1.update(publicKeyDer);
        return sha1.digest();
    }

    /**
     * Computes the Minecraft server hash: {@code signedHex(sha1(serverId || sharedSecret || publicKeyDer))}.
     *
     * @param serverId the per-challenge ASCII salt from the challenge response
     * @param sharedSecret the 16 random bytes generated for this login
     * @param publicKeyDer the DER (X.509 SubjectPublicKeyInfo) bytes of the server RSA public key —
     *     the same bytes that were Base64-decoded from {@code ChallengeResponse.publicKey}
     */
    public static String compute(String serverId, byte[] sharedSecret, byte[] publicKeyDer) {
        return toSignedHex(digest(serverId, sharedSecret, publicKeyDer));
    }

    /**
     * Reinterprets a 20-byte SHA-1 digest as a signed 160-bit big-endian integer and renders it as
     * lowercase hex.
     *
     * @param digest exactly {@link #DIGEST_BYTES} bytes
     */
    public static String toSignedHex(byte[] digest) {
        Objects.requireNonNull(digest, "digest");
        if (digest.length != DIGEST_BYTES) {
            throw new IllegalArgumentException("expected a " + DIGEST_BYTES + "-byte SHA-1 digest, got " + digest.length);
        }
        return new BigInteger(digest).toString(16);
    }

    private static byte[] asciiBytes(String value) {
        byte[] bytes = new byte[value.length()];
        for (int i = 0; i < bytes.length; i++) {
            char c = value.charAt(i);
            if (c > 0x7F) {
                throw new IllegalArgumentException(
                        "serverId must be ASCII, found U+" + String.format("%04x", (int) c) + " at index " + i);
            }
            bytes[i] = (byte) c;
        }
        return bytes;
    }

    /** Convenience: the ASCII bytes of a string, without the charset round-trip. */
    static byte[] ascii(String value) {
        return value.getBytes(StandardCharsets.US_ASCII);
    }
}
