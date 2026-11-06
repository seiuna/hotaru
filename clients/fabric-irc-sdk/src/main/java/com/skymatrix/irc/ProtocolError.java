package com.skymatrix.irc;

/**
 * A {@code protocol.error} frame from the server.
 *
 * @param code stable SRP error code, e.g. {@code RATE_LIMITED}, {@code TYPE_DENIED}
 * @param message short human-readable description
 * @param replyTo the message it refers to, when the error is about a specific send
 */
public record ProtocolError(String code, String message, String replyTo) {

    /** Exactly the codes SRP v1 defines; anything else is surfaced as-is. */
    public boolean isRateLimited() {
        return "RATE_LIMITED".equals(code);
    }

    public boolean isTypeDenied() {
        return "TYPE_DENIED".equals(code);
    }

    public boolean isAuthProblem() {
        return "UNAUTHORIZED".equals(code)
                || "TOKEN_EXPIRED".equals(code)
                || "SCOPE_DENIED".equals(code)
                || "SESSION_REVOKED".equals(code);
    }

    @Override
    public String toString() {
        return "ProtocolError[" + code + ": " + message
                + (replyTo == null ? "" : ", replyTo=" + replyTo) + "]";
    }
}
