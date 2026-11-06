package cn.seiua.mcauth;

import cn.seiua.json.Json;

import java.util.List;
import java.util.Map;

/**
 * A token pair plus the authoritative profile, as returned by
 * {@code POST /api/v1/auth/minecraft/verify} and {@code POST /api/v1/auth/refresh}.
 *
 * <p>Wire shape (see {@code tokenResponseSchema} in {@code @skymatrix/api-contract}):
 *
 * <pre>{@code
 * {
 *   "accessToken":  "eyJhbGciOiJFZERTQSIs...",   // Ed25519 JWT, ~15 min
 *   "refreshToken": "v1:9f0c...",                 // rotating, single use
 *   "tokenType":    "Bearer",
 *   "expiresIn":    900,                          // seconds
 *   "profile":      { "uuid": "069a79f4-...", "username": "Notch" },
 *   "scopes":       ["skymatrix:profile", "skymatrix:resource"]
 * }
 * }</pre>
 *
 * <p><strong>Storage:</strong> the refresh token is a bearer credential. Keep it in memory or in an
 * OS-level secret store; never write it to a log, a chat message or a world save.
 *
 * @param accessToken the MC Auth JWT, sent as {@code Authorization: Bearer <token>}
 * @param refreshToken the single-use rotation token — persist it, it is the only way to survive a
 *     restart without a new Mojang join
 * @param tokenType always {@code "Bearer"}
 * @param expiresIn access-token lifetime in seconds
 * @param profile the profile the server resolved from Mojang (client-supplied UUIDs are ignored)
 * @param scopes effective scopes computed by the server from MongoDB
 */
public record TokenResponse(
        String accessToken,
        String refreshToken,
        String tokenType,
        int expiresIn,
        TokenProfile profile,
        List<String> scopes) {

    public TokenResponse {
        if (accessToken == null || accessToken.isBlank()) throw new IllegalArgumentException("accessToken is blank");
        if (refreshToken == null || refreshToken.isBlank()) throw new IllegalArgumentException("refreshToken is blank");
        if (tokenType == null || tokenType.isBlank()) throw new IllegalArgumentException("tokenType is blank");
        if (expiresIn <= 0) throw new IllegalArgumentException("expiresIn must be positive");
        if (profile == null) throw new IllegalArgumentException("profile is null");
        scopes = scopes == null ? List.of() : List.copyOf(scopes);
    }

    /** Value for the {@code Authorization} header: {@code "Bearer <accessToken>"}. */
    public String authorizationHeader() {
        return tokenType + " " + accessToken;
    }

    /** {@code true} when {@code scope} is present in the issued token. */
    public boolean hasScope(String scope) {
        return scopes.contains(scope);
    }

    /** Maps the wire object onto this record, failing with {@code INVALID_RESPONSE} on any gap. */
    static TokenResponse fromJson(Map<String, Object> json, int httpStatus) throws McAuthException {
        try {
            Map<String, Object> profileJson = Json.requireObject(json, "profile");
            return new TokenResponse(
                    Json.requireString(json, "accessToken"),
                    Json.requireString(json, "refreshToken"),
                    Json.requireString(json, "tokenType"),
                    Json.requireInt(json, "expiresIn"),
                    new TokenProfile(
                            Json.requireString(profileJson, "uuid"),
                            Json.requireString(profileJson, "username")),
                    Json.requireStringArray(json, "scopes"));
        } catch (IllegalArgumentException e) {
            throw new McAuthException(
                    ApiErrorCode.INVALID_RESPONSE,
                    "token response does not match the contract: " + e.getMessage(),
                    httpStatus,
                    false,
                    null,
                    e);
        }
    }

    /** Never render the tokens by accident: {@code toString()} is redacted. */
    @Override
    public String toString() {
        return "TokenResponse[tokenType=" + tokenType
                + ", expiresIn=" + expiresIn
                + ", profile=" + profile
                + ", scopes=" + scopes
                + ", accessToken=<redacted>, refreshToken=<redacted>]";
    }
}
