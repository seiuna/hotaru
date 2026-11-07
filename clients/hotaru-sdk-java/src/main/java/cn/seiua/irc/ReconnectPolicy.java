package cn.seiua.irc;

import java.util.concurrent.ThreadLocalRandom;

/**
 * Exponential backoff with jitter, as required by the design (avoid reconnect
 * storms). Instances are immutable and reusable.
 */
public final class ReconnectPolicy {

    private final long baseDelayMs;
    private final long maxDelayMs;
    private final double jitterRatio;
    private final int maxAttempts;

    public ReconnectPolicy(long baseDelayMs, long maxDelayMs, double jitterRatio, int maxAttempts) {
        if (baseDelayMs <= 0) throw new IllegalArgumentException("baseDelayMs must be positive");
        if (maxDelayMs < baseDelayMs) throw new IllegalArgumentException("maxDelayMs must be >= baseDelayMs");
        if (jitterRatio < 0 || jitterRatio > 1) throw new IllegalArgumentException("jitterRatio must be 0..1");
        if (maxAttempts < 1) throw new IllegalArgumentException("maxAttempts must be >= 1");
        this.baseDelayMs = baseDelayMs;
        this.maxDelayMs = maxDelayMs;
        this.jitterRatio = jitterRatio;
        this.maxAttempts = maxAttempts;
    }

    /** 500 ms → 30 s, ±20 % jitter, unlimited attempts. */
    public static ReconnectPolicy defaults() {
        return new ReconnectPolicy(500, 30_000, 0.2, Integer.MAX_VALUE);
    }

    /** No automatic reconnect: the client stops after the first failure. */
    public static ReconnectPolicy disabled() {
        return new ReconnectPolicy(500, 30_000, 0.2, 1);
    }

    /** Attempt numbers start at 1. */
    public long delayForAttempt(int attempt) {
        int safeAttempt = Math.max(1, attempt);
        long exponential = baseDelayMs * (1L << Math.min(20, safeAttempt - 1));
        long capped = Math.min(maxDelayMs, exponential);
        if (jitterRatio == 0) return capped;
        double spread = capped * jitterRatio;
        long jitter = (long) (ThreadLocalRandom.current().nextDouble(-spread, spread));
        return Math.max(baseDelayMs / 2, capped + jitter);
    }

    public boolean canRetry(int attempt) {
        return attempt < maxAttempts;
    }

    public int maxAttempts() {
        return maxAttempts;
    }
}
