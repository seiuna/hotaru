import type { Redis } from 'ioredis';
import { Errors } from '../../errors.js';

/** Fixed windows, contract key names: `auth:rate:ip:{ip}`, `auth:rate:uuid:{uuid}`. */
export const RATE_LIMIT_IP_PREFIX = 'auth:rate:ip:';
export const RATE_LIMIT_USERNAME_PREFIX = 'auth:rate:uuid:';

export interface RateLimitResult {
  allowed: boolean;
  /** Hits in the current window, including this one. */
  count: number;
  retryAfterSeconds: number;
}

export function rateLimitIpKey(ip: string): string {
  return `${RATE_LIMIT_IP_PREFIX}${ip}`;
}

/** Keyed by username because the challenge happens before Mojang tells us the UUID. */
export function rateLimitUsernameKey(username: string): string {
  return `${RATE_LIMIT_USERNAME_PREFIX}${username.toLowerCase()}`;
}

/**
 * INCR + first-hit EXPIRE in one atomic round trip. The window is fixed (not
 * sliding) on purpose: it bounds work per key and is trivial to reason about.
 */
const RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

export async function consumeRateLimit(
  redis: Redis,
  key: string,
  max: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const reply = await redis.eval(RATE_LIMIT_SCRIPT, 1, key, String(Math.max(1, windowSeconds)));
  if (!Array.isArray(reply) || reply.length !== 2) {
    throw Errors.internal(new Error('unexpected RATE_LIMIT reply'));
  }
  const [countRaw, ttlRaw] = reply as unknown[];
  const count = typeof countRaw === 'number' ? countRaw : Number(countRaw);
  const ttl = typeof ttlRaw === 'number' ? ttlRaw : Number(ttlRaw);
  if (!Number.isFinite(count)) throw Errors.internal(new Error('unexpected RATE_LIMIT count'));

  return {
    allowed: count <= max,
    count,
    retryAfterSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl : Math.max(1, windowSeconds),
  };
}
