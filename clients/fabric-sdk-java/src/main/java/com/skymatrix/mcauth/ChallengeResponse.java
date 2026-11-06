package com.skymatrix.mcauth;

import com.skymatrix.mcauth.json.Json;

import java.util.Base64;
import java.util.Map;
import java.util.Objects;

/**
 * The server's answer to {@code POST /api/v1/auth/minecraft/challenge} — a one-time, short-lived
 * challenge that binds one Minecraft session join to one verify call.
 *
 * <p>Wire shape (see {@code challengeResponseSchema} in {@code @skymatrix/api-contract}):
 *
 * <pre>{@code
 * {
 *   "challengeId": "0f8fad5b-d9cb-469f-a165-70867728950e",
 *   "serverId":    "yJx3hr...",             // random per-challenge salt for the Mojang hash
 *   "publicKey":   "MIIBIjANBgkqhki...",     // Base64 DER (X.509 SubjectPublicKeyInfo), RSA
 *   "verifyToken": "mF3k0Q==",               // Base64 of 4 random bytes
 *   "expiresIn":   120                       // seconds
 * }
 * }</pre>
 *
 * <p>{@link #publicKeyDer()} and {@link #verifyToken()} return the <em>decoded</em> bytes; the
 * ciphertext and the hash input are always built from those bytes, never from the Base64 text.
 *
 * @param challengeId opaque id that must be echoed on verify
 * @param serverId random ASCII salt; hashed together with the shared secret
 * @param publicKeyBase64 Base64 DER of the server RSA public key (the same bytes are hashed)
 * @param verifyTokenBase64 Base64 of the 4 random bytes to RSA-encrypt and echo back
 * @param expiresIn lifetime of the challenge in seconds
 */
public record ChallengeResponse(
        String challengeId,
        String serverId,
        String publicKeyBase64,
        String verifyTokenBase64,
        int expiresIn) {

    public ChallengeResponse {
        Objects.requireNonNull(challengeId, "challengeId");
        Objects.requireNonNull(serverId, "serverId");
        Objects.requireNonNull(publicKeyBase64, "publicKeyBase64");
        Objects.requireNonNull(verifyTokenBase64, "verifyTokenBase64");
        if (challengeId.isBlank()) throw new IllegalArgumentException("challengeId is blank");
        if (serverId.isEmpty()) throw new IllegalArgumentException("serverId is empty");
        if (publicKeyBase64.isBlank()) throw new IllegalArgumentException("publicKey is blank");
        if (verifyTokenBase64.isBlank()) throw new IllegalArgumentException("verifyToken is blank");
    }

    /** Decoded DER (X.509 SubjectPublicKeyInfo) bytes of the server RSA public key. */
    public byte[] publicKeyDer() {
        return decodeBase64(publicKeyBase64, "publicKey");
    }

    /** Decoded raw verify token bytes (4 bytes) that must be RSA-encrypted and echoed back. */
    public byte[] verifyToken() {
        return decodeBase64(verifyTokenBase64, "verifyToken");
    }

    private static byte[] decodeBase64(String encoded, String field) {
        try {
            return Base64.getDecoder().decode(encoded);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("challenge field '" + field + "' is not valid Base64", e);
        }
    }

    /** Maps the wire object onto this record, failing with {@code INVALID_RESPONSE} on any gap. */
    static ChallengeResponse fromJson(Map<String, Object> json, int httpStatus) throws McAuthException {
        try {
            return new ChallengeResponse(
                    Json.requireString(json, "challengeId"),
                    Json.requireString(json, "serverId"),
                    Json.requireString(json, "publicKey"),
                    Json.requireString(json, "verifyToken"),
                    Json.requireInt(json, "expiresIn"));
        } catch (IllegalArgumentException e) {
            throw new McAuthException(
                    ApiErrorCode.INVALID_RESPONSE,
                    "challenge response does not match the contract: " + e.getMessage(),
                    httpStatus,
                    false,
                    null,
                    e);
        }
    }
}
