package com.skymatrix.irc.rest;

/** A non-2xx answer from the REST API, carrying the server's stable error code. */
public class ApiException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    private final int statusCode;
    private final String code;

    public ApiException(int statusCode, String code, String message) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
    }

    public int statusCode() {
        return statusCode;
    }

    /** e.g. {@code GROUP_NOT_FOUND}, {@code GROUP_ACCESS_DENIED}, {@code RATE_LIMITED}. */
    public String code() {
        return code;
    }

    public boolean isNotFound() {
        return statusCode == 404;
    }

    public boolean isForbidden() {
        return statusCode == 403;
    }

    public boolean isRateLimited() {
        return statusCode == 429;
    }

    @Override
    public String toString() {
        return "ApiException[" + statusCode + " " + code + ": " + getMessage() + "]";
    }
}
