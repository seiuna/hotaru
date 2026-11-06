import type { Redis } from 'ioredis';
import type { AppContext } from '../../context.js';

/**
 * Per-user group-creation quota (`config.createGroupPerHour`), enforced at the
 * HTTP boundary.
 *
 * Fixed window in Redis: one key per user per clock hour, incremented and given a
 * TTL in a single MULTI so two concurrent requests cannot both read "under the
 * limit". The window index comes from `ctx.now()`, the same injectable clock the
 * rest of the server uses, so tests can pin it.
 *
 * Failure policy: **fail open**. This is an anti-abuse limit, not a security
 * gate — Redis being down must not stop players from creating groups. A failed
 * check is logged and treated as "allowed". (Contrast with the filter service and
 * session revocation, where an unavailable Redis fails closed.)
 */

const WINDOW_MS = 60 * 60 * 1000;
const KEY_PREFIX = 'irc:ratelimit:creategroup';

export type GroupCreationDecision =
  | { allowed: true; used: number; limit: number }
  | { allowed: false; used: number; limit: number; retryAfterSeconds: number };

export interface GroupCreationQuota {
  /** Counts one attempt against the caller's hourly window. */
  consume(userUuid: string): Promise<GroupCreationDecision>;
}

export interface GroupCreationQuotaOptions {
  /** Only `multi` is used, so tests can pass a minimal double. */
  redis: Pick<Redis, 'multi'>;
  limit: number;
  now: () => number;
}

export function createGroupCreationQuotaFor(options: GroupCreationQuotaOptions): GroupCreationQuota {
  const { redis, limit, now } = options;

  return {
    async consume(userUuid: string): Promise<GroupCreationDecision> {
      const uuid = typeof userUuid === 'string' ? userUuid.trim().toLowerCase() : '';
      // An empty identity cannot be keyed; the route always supplies one, and the
      // JWT guard runs first, so this is only a defensive path.
      if (uuid.length === 0) return { allowed: true, used: 0, limit };

      const at = now();
      const window = Math.floor(at / WINDOW_MS);
      const key = `${KEY_PREFIX}:${uuid}:${window}`;

      try {
        // INCR + PEXPIRE in one round trip: the counter exists with a TTL or not
        // at all, so a crash between the two commands cannot leak a permanent key.
        const results = await redis.multi().incr(key).pexpire(key, WINDOW_MS).exec();
        const first = results?.[0];
        if (!first) throw new Error('rate limit transaction was aborted');
        if (first[0]) throw first[0];

        const used = Number(first[1]);
        if (!Number.isFinite(used)) throw new Error('rate limit counter returned a non-numeric value');

        if (used <= limit) return { allowed: true, used, limit };

        const windowEndsAt = (window + 1) * WINDOW_MS;
        const retryAfterSeconds = Math.max(1, Math.ceil((windowEndsAt - at) / 1000));
        return { allowed: false, used, limit, retryAfterSeconds };
      } catch (error) {
        // Fail open, but leave a trace: a limiter that nobody notices is broken
        // is the same as no limiter at all.
        console.warn(
          '[irc-groups] group-creation rate limit unavailable; allowing the request',
          error instanceof Error ? error.message : error,
        );
        return { allowed: true, used: 0, limit };
      }
    },
  };
}

/** Production wiring: the configured limit, the shared Redis and the server clock. */
export function createGroupCreationQuota(ctx: AppContext): GroupCreationQuota {
  return createGroupCreationQuotaFor({
    redis: ctx.redis,
    limit: ctx.config.createGroupPerHour,
    now: ctx.now,
  });
}
