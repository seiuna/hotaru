import { describe, expect, it } from 'vitest';
import { TokenBucket } from './rate-limit.js';

function clock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

describe('TokenBucket', () => {
  it('allows a burst up to the bucket size, then refuses', () => {
    const time = clock();
    const bucket = new TokenBucket(20, 3, time.now);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });

  it('refills at the configured rate', () => {
    const time = clock();
    const bucket = new TokenBucket(10, 2, time.now);
    bucket.tryConsume();
    bucket.tryConsume();
    expect(bucket.tryConsume()).toBe(false);

    time.advance(100); // 10/s → one token per 100ms
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });

  it('never exceeds the burst when idle for long', () => {
    const time = clock();
    const bucket = new TokenBucket(10, 2, time.now);
    bucket.tryConsume();
    bucket.tryConsume();
    time.advance(60_000);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });

  it('reports a retry hint when empty', () => {
    const time = clock();
    const bucket = new TokenBucket(10, 1, time.now);
    expect(bucket.retryAfterSeconds()).toBe(0);
    bucket.tryConsume();
    expect(bucket.retryAfterSeconds()).toBeGreaterThan(0);
  });
});
