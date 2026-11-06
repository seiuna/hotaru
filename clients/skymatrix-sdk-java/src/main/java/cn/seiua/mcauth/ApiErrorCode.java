package cn.seiua.mcauth;

/**
 * Machine-readable error codes of the MC Auth API.
 *
 * <p>The constants in the first block are the server's own codes — they mirror
 * {@code ERROR_CODES} in {@code @skymatrix/shared-types} and are stable, so a mod may branch on
 * them ({@code switch (e.errorCode()) { case ApiErrorCode.NOT_A_PREMIUM_SESSION: ... }}).
 *
 * <p>The constants in the second block are produced locally by this SDK and are never sent by the
 * server: transport failures, unparsable/unexpected responses, and a Mojang {@code join} rejection.
 */
public final class ApiErrorCode {

    /* ---------------------------------------------------------------- */
    /* Server codes (packages/shared-types/src/index.ts → ERROR_CODES)   */
    /* ---------------------------------------------------------------- */

    public static final String INVALID_REQUEST = "INVALID_REQUEST";
    public static final String CHALLENGE_NOT_FOUND = "CHALLENGE_NOT_FOUND";
    public static final String CHALLENGE_EXPIRED = "CHALLENGE_EXPIRED";
    public static final String CHALLENGE_CONSUMED = "CHALLENGE_CONSUMED";
    public static final String NOT_A_PREMIUM_SESSION = "NOT_A_PREMIUM_SESSION";
    public static final String MOJANG_UNAVAILABLE = "MOJANG_UNAVAILABLE";
    public static final String RATE_LIMITED = "RATE_LIMITED";
    public static final String UNAUTHORIZED = "UNAUTHORIZED";
    public static final String TOKEN_EXPIRED = "TOKEN_EXPIRED";
    public static final String SESSION_REVOKED = "SESSION_REVOKED";
    public static final String REFRESH_REUSED = "REFRESH_REUSED";
    public static final String USER_BANNED = "USER_BANNED";
    public static final String FORBIDDEN = "FORBIDDEN";
    public static final String NOT_FOUND = "NOT_FOUND";
    public static final String INTERNAL = "INTERNAL";

    /* ---------------------------------------------------------------- */
    /* Codes produced by this SDK                                        */
    /* ---------------------------------------------------------------- */

    /** The HTTP request itself failed (DNS, connect timeout, TLS, request timeout, ...). Retryable. */
    public static final String TRANSPORT_ERROR = "TRANSPORT_ERROR";

    /** A successful-looking response whose body is missing, malformed or violates the contract. */
    public static final String INVALID_RESPONSE = "INVALID_RESPONSE";

    /** Mojang answered {@code /session/minecraft/join} with a non-retryable rejection (bad token). */
    public static final String MOJANG_JOIN_REJECTED = "MOJANG_JOIN_REJECTED";

    /** A non-2xx response that carried no parsable {@code error.code}. {@code "HTTP_<status>"} is used instead. */
    public static final String HTTP_PREFIX = "HTTP_";

    /** Fallback when no code could be determined at all. */
    public static final String UNKNOWN = "UNKNOWN";

    private ApiErrorCode() {
        // Constants only.
    }
}
