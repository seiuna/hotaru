package cn.seiua.mcauth;

import javax.crypto.Cipher;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;
import java.util.Objects;

/**
 * The cryptographic half of the Minecraft join handshake, with no game or JSON dependencies.
 *
 * <p>For every login the client must:
 *
 * <ol>
 *   <li>generate a <strong>16-byte</strong> random shared secret (this is the value that would also
 *       become the AES key of a real Minecraft connection — here it only proves to the server that
 *       the client completed the handshake);
 *   <li>RSA/PKCS#1 v1.5 encrypt the shared secret with the server's public key;
 *   <li>RSA/PKCS#1 v1.5 encrypt the server's verify token (4 raw bytes, Base64-decoded from the
 *       challenge) with the same public key;
 *   <li>compute {@link MinecraftServerHash} over the server id, the shared secret and the public key
 *       DER bytes.
 * </ol>
 *
 * <p>Only the ciphertexts leave the client together with the hash — the shared secret itself is never
 * transmitted, and the MC Auth server never sees the Mojang access token.
 *
 * <p>Thread-safe: {@link SecureRandom} is internally synchronised.
 */
public final class HandshakeCrypto {

    /** Length of the shared secret, in bytes, exactly as the vanilla client uses. */
    public static final int SHARED_SECRET_BYTES = 16;

    /** The transformation required by the protocol — PKCS#1 v1.5, never OAEP. */
    public static final String RSA_TRANSFORMATION = "RSA/ECB/PKCS1Padding";

    private static final SecureRandom DEFAULT_RANDOM = new SecureRandom();

    private HandshakeCrypto() {
        // Static utility class.
    }

    /** Generates a fresh 16-byte shared secret from the JVM's strongest {@link SecureRandom}. */
    public static byte[] generateSharedSecret() {
        return generateSharedSecret(DEFAULT_RANDOM);
    }

    /** Generates a fresh 16-byte shared secret from the supplied random source. */
    public static byte[] generateSharedSecret(SecureRandom random) {
        Objects.requireNonNull(random, "random");
        byte[] secret = new byte[SHARED_SECRET_BYTES];
        random.nextBytes(secret);
        return secret;
    }

    /** Decodes a Base64 DER (X.509 SubjectPublicKeyInfo) RSA public key. */
    public static PublicKey decodeRsaPublicKey(byte[] publicKeyDer) throws McAuthException {
        Objects.requireNonNull(publicKeyDer, "publicKeyDer");
        try {
            return KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(publicKeyDer));
        } catch (GeneralSecurityException e) {
            throw new McAuthException(
                    ApiErrorCode.INVALID_RESPONSE,
                    "the server's publicKey is not a valid X.509 RSA public key",
                    0,
                    false,
                    null,
                    e);
        }
    }

    /**
     * Encrypts {@code plaintext} with the server public key using {@value #RSA_TRANSFORMATION}.
     *
     * @param publicKeyDer DER bytes decoded from {@code ChallengeResponse.publicKey}
     * @param plaintext the shared secret or the raw verify token bytes
     * @return the RSA ciphertext (always as long as the key modulus)
     */
    public static byte[] rsaEncrypt(byte[] publicKeyDer, byte[] plaintext) throws McAuthException {
        Objects.requireNonNull(plaintext, "plaintext");
        PublicKey publicKey = decodeRsaPublicKey(publicKeyDer);
        try {
            Cipher cipher = Cipher.getInstance(RSA_TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, publicKey);
            return cipher.doFinal(plaintext);
        } catch (GeneralSecurityException e) {
            throw new McAuthException(
                    ApiErrorCode.INVALID_RESPONSE,
                    "RSA/PKCS#1 encryption with the server public key failed: " + e.getMessage(),
                    0,
                    false,
                    null,
                    e);
        }
    }

    /** {@link #rsaEncrypt(byte[], byte[])} result as standard Base64 — the wire format. */
    public static String rsaEncryptBase64(byte[] publicKeyDer, byte[] plaintext) throws McAuthException {
        return Base64.getEncoder().encodeToString(rsaEncrypt(publicKeyDer, plaintext));
    }
}
