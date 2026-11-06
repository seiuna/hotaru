/**
 * Per-connection token bucket.
 *
 * Deliberately in-memory: the limit protects *this* node from one noisy socket,
 * and Redis round-trips on the message hot path would cost more than they buy.
 * Cross-node abuse is bounded by per-user connection limits and the auth layer.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.lastRefill = now();
  }

  /** Consumes one token if available; returns false when the caller is over budget. */
  tryConsume(cost = 1): boolean {
    this.refill();
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  /** Seconds until the next token, for a Retry-After hint. */
  retryAfterSeconds(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil((1 - this.tokens) / this.ratePerSecond);
  }

  private refill(): void {
    const now = this.now();
    const elapsedSeconds = Math.max(0, (now - this.lastRefill) / 1000);
    if (elapsedSeconds <= 0) return;
    this.tokens = Math.min(this.burst, this.tokens + elapsedSeconds * this.ratePerSecond);
    this.lastRefill = now;
  }
}
