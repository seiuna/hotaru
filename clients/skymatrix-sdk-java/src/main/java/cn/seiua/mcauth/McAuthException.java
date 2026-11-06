package cn.seiua.mcauth;

import cn.seiua.json.Json;

import java.util.Map;

/**
 * Every failure of the MC Auth flow is reported as a {@code McAuthException}.
 *
 * <p>It carries the three things a client needs to react correctly:
 *
 * <ul>
 *   <li>{@link #httpStatus()} — the HTTP status, or {@code 0} when no response was received
 *       (transport failure, local crypto failure);
 *   <li>{@link #errorCode()} — the server's {@code error.code}, e.g. {@code NOT_A_PREMIUM_SESSION},
 *       {@code CHALLENGE_CONSUMED}, {@code MOJANG_UNAVAILABLE}. See {@link ApiErrorCode}; the code is
 *       kept verbatim, so codes added by the server later still surface intact;
 *   <li>{@link #retryable()} — whether retrying the same operation can succeed. The server states this
 *       explicitly in its error envelope; for responses without one it is inferred from the status
 *       (429 and 5xx).
 * </ul>
 *
 * <p>{@link #details()} holds the optional {@code error.details} JSON value (a {@code Map}, {@code
 * List}, {@code String}, number, boolean or {@code null}) — for example {@code {retryAfterSeconds}} on
 * a {@code RATE_LIMITED} response.
 *
 * <p><strong>Security:</strong> messages never contain the Minecraft access token, the shared secret
 * or the verify token, and neither do they echo request bodies.
 */
public class McAuthException extends Exception {

    private static final long serialVersionUID = 1L;

    private final int httpStatus;
    private final String errorCode;
    private final boolean retryable;
    /** Transient: error details are diagnostic data and must never travel with a serialized exception. */
    private final transient Object details;

    public McAuthException(
            String errorCode,
            String message,
            int httpStatus,
            boolean retryable,
            Object details,
            Throwable cause) {
        super(message, cause);
        this.errorCode = errorCode == null || errorCode.isBlank() ? ApiErrorCode.UNKNOWN : errorCode;
        this.httpStatus = httpStatus;
        this.retryable = retryable;
        this.details = details;
    }

    /** HTTP status of the failed response, or {@code 0} when no response was received. */
    public int httpStatus() {
        return httpStatus;
    }

    /** Server {@code error.code} (see {@link ApiErrorCode}), or a local SDK code. Never blank. */
    public String errorCode() {
        return errorCode;
    }

    /** {@code true} when retrying the same operation may succeed (429, 5xx, transport failures). */
    public boolean retryable() {
        return retryable;
    }

    /** Optional {@code error.details} value from the server envelope; {@code null} when absent. */
    public Object details() {
        return details;
    }

    /* ------------------------------------------------------------------ */
    /* Factories                                                           */
    /* ------------------------------------------------------------------ */

    /** The request never produced a response (DNS/connect/TLS/timeout). Always retryable. */
    static McAuthException transport(String message, Throwable cause) {
        return new McAuthException(ApiErrorCode.TRANSPORT_ERROR, message, 0, true, null, cause);
    }

    /**
     * Builds the exception for a non-2xx response. The body is parsed as the standard
     * {@code {"error":{"code","message","retryable","details?"}}} envelope; anything else falls back to
     * {@code HTTP_<status>} with the raw body as the message.
     */
    public static McAuthException fromHttp(int status, String body) {
        String code = null;
        String message = null;
        Boolean retryable = null;
        Object details = null;

        if (body != null && !body.isBlank()) {
            try {
                Object parsed = Json.parse(body);
                if (parsed instanceof Map<?, ?> envelope && envelope.get("error") instanceof Map<?, ?> error) {
                    Object rawCode = error.get("code");
                    if (rawCode instanceof String text && !text.isBlank()) code = text;
                    Object rawMessage = error.get("message");
                    if (rawMessage instanceof String text) message = text;
                    Object rawRetryable = error.get("retryable");
                    if (rawRetryable instanceof Boolean flag) retryable = flag;
                    details = error.get("details");
                }
            } catch (RuntimeException ignored) {
                // Not JSON (a proxy error page, an empty gateway response, ...): fall back below.
            }
        }

        if (code == null) {
            if (status == 429) {
                code = ApiErrorCode.RATE_LIMITED;
            } else if (status >= 500) {
                code = ApiErrorCode.INTERNAL;
            } else {
                code = ApiErrorCode.HTTP_PREFIX + status;
            }
        }

        if (message == null) {
            String snippet = body == null ? "" : body.strip();
            if (snippet.length() > 300) snippet = snippet.substring(0, 300) + "...";
            message = "HTTP " + status + (snippet.isEmpty() ? " (empty body)" : ": " + snippet);
        }

        boolean canRetry = retryable != null ? retryable : (status == 429 || status >= 500);
        return new McAuthException(code, message, status, canRetry, details, null);
    }

    @Override
    public String toString() {
        return "McAuthException[" + errorCode
                + (httpStatus > 0 ? ", HTTP " + httpStatus : ", no HTTP response")
                + ", retryable=" + retryable + "]: " + getMessage();
    }
}
