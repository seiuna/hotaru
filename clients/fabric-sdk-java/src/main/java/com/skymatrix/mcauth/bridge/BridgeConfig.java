package com.skymatrix.mcauth.bridge;

import java.time.Duration;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Configuration for {@link LocalAuthBridge}.
 *
 * @param bindAddress interface to bind; must stay a loopback address — the bridge hands out tokens and
 *     must never be reachable from the LAN
 * @param port TCP port on the loopback interface; 0 means "pick a free port" (tests)
 * @param allowedOrigins exact browser origins allowed to call the bridge, e.g.
 *     {@code https://admin.example.com}. Compared case-insensitively, without any trailing slash.
 *     A wildcard is deliberately unsupported.
 * @param approvalTimeout how long a pending in-game confirmation may take before the browser request
 *     fails with {@code APPROVAL_TIMEOUT}
 * @param maxLoginsPerMinute per-origin rate limit; a page that spams the port must not be able to
 *     trigger repeated handshakes
 * @param allowPrivateNetwork emit {@code Access-Control-Allow-Private-Network: true} so Chromium's
 *     Private Network Access preflight succeeds for public pages calling into 127.0.0.1
 */
public record BridgeConfig(
        String bindAddress,
        int port,
        Set<String> allowedOrigins,
        Duration approvalTimeout,
        int maxLoginsPerMinute,
        boolean allowPrivateNetwork) {

    public static final String LOOPBACK = "127.0.0.1";
    public static final int DEFAULT_PORT = 8765;

    public BridgeConfig {
        if (bindAddress == null || bindAddress.isBlank()) throw new IllegalArgumentException("bindAddress is blank");
        if (!LOOPBACK.equals(bindAddress) && !"localhost".equals(bindAddress)) {
            throw new IllegalArgumentException("the bridge may only bind loopback, got " + bindAddress);
        }
        if (port < 0 || port > 65535) throw new IllegalArgumentException("port out of range: " + port);
        if (allowedOrigins == null || allowedOrigins.isEmpty()) {
            throw new IllegalArgumentException("allowedOrigins must contain at least one origin");
        }
        if (approvalTimeout == null || approvalTimeout.isNegative() || approvalTimeout.isZero()) {
            throw new IllegalArgumentException("approvalTimeout must be positive");
        }
        if (maxLoginsPerMinute <= 0) throw new IllegalArgumentException("maxLoginsPerMinute must be positive");

        Set<String> normalised = new LinkedHashSet<>();
        for (String origin : allowedOrigins) {
            normalised.add(normaliseOrigin(origin));
        }
        allowedOrigins = Set.copyOf(normalised);
    }

    /** Builds a config for the given browser origins on {@value #DEFAULT_PORT}. */
    public static BridgeConfig forOrigins(String... origins) {
        return forOrigins(DEFAULT_PORT, origins);
    }

    public static BridgeConfig forOrigins(int port, String... origins) {
        return new BridgeConfig(
                LOOPBACK,
                port,
                Set.of(origins),
                Duration.ofSeconds(60),
                5,
                true);
    }

    /**
     * Normalises an origin to the exact string a browser sends in {@code Origin}:
     * lower-case scheme and host, optional port, no trailing slash, no path.
     */
    public static String normaliseOrigin(String origin) {
        if (origin == null) throw new IllegalArgumentException("origin is null");
        String value = origin.trim();
        if (value.isEmpty()) throw new IllegalArgumentException("origin is blank");
        int schemeEnd = value.indexOf("://");
        if (schemeEnd <= 0) throw new IllegalArgumentException("origin is not absolute: " + origin);
        value = value.substring(0, schemeEnd).toLowerCase(Locale.ROOT) + value.substring(schemeEnd);
        while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
        // Strip any path/query/fragment: an Origin header never carries one.
        int firstSlash = value.indexOf('/', schemeEnd + 3);
        if (firstSlash > 0) value = value.substring(0, firstSlash);
        return value.toLowerCase(Locale.ROOT);
    }

    /** {@code true} when the browser origin may call this bridge. */
    public boolean allows(String origin) {
        if (origin == null || origin.isBlank()) return false;
        try {
            return allowedOrigins.contains(normaliseOrigin(origin));
        } catch (IllegalArgumentException ignored) {
            return false;
        }
    }

    public int resolvedPort() {
        return port;
    }
}
