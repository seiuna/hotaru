import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { loadConfig } from '../../config/env.js';
import type { AppContext } from '../../context.js';
import { createGroupCreationQuota, createGroupCreationQuotaFor } from './quota.js';

/**
 * Unit coverage for the group-creation quota. `createGroupCreationQuotaFor` takes
 * only the pieces it needs (`multi`, the limit, the clock), so the test never
 * touches a real Redis or Mongo — it asserts the exact Redis commands issued and
 * the three behaviours the Lead asked for: allow up to N, 429 on N+1, fail open
 * when Redis is unavailable.
 */

const HOUR_MS = 60 * 60 * 1000;
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const START = Math.floor(1_700_000_000_000 / HOUR_MS) * HOUR_MS; // exact window start

interface FakePipeline {
  incr(key: string): FakePipeline;
  pexpire(key: string, ms: number): FakePipeline;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

class FakeRedis {
  readonly counts = new Map<string, number>();
  readonly ttls = new Map<string, number>();
  readonly commands: string[] = [];
  /** 'exec' throws, 'result' returns an error tuple, null works normally. */
  failure: 'exec' | 'result' | null = null;

  multi(): FakePipeline {
    const operations: Array<() => unknown> = [];

    const pipeline: FakePipeline = {
      incr: (key: string) => {
        this.commands.push(`incr ${key}`);
        operations.push(() => {
          const next = (this.counts.get(key) ?? 0) + 1;
          this.counts.set(key, next);
          return next;
        });
        return pipeline;
      },
      pexpire: (key: string, ms: number) => {
        this.commands.push(`pexpire ${key} ${ms}`);
        operations.push(() => {
          this.ttls.set(key, ms);
          return 1;
        });
        return pipeline;
      },
      exec: async () => {
        if (this.failure === 'exec') throw new Error('redis is down');
        if (this.failure === 'result') return [[new Error('ERR command failed'), null]];
        return operations.map((operation) => [null, operation()] as [null, unknown]);
      },
    };

    return pipeline;
  }
}

function quotaWith(fake: FakeRedis, limit: number, clock: { now: number }) {
  return createGroupCreationQuotaFor({
    redis: fake as unknown as Pick<Redis, 'multi'>,
    limit,
    now: () => clock.now,
  });
}

describe('group creation quota', () => {
  it('allows exactly `limit` creations per user per window, then denies', async () => {
    const fake = new FakeRedis();
    const clock = { now: START };
    const quota = quotaWith(fake, 3, clock);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await expect(quota.consume(ALICE)).resolves.toEqual({ allowed: true, used: attempt, limit: 3 });
    }

    const denied = await quota.consume(ALICE);
    expect(denied).toMatchObject({ allowed: false, used: 4, limit: 3 });
    if (denied.allowed) throw new Error('expected the quota to deny');
    expect(denied.retryAfterSeconds).toBe(3600); // clock is at the exact window start
  });

  it('uses one fixed-window key per user and sets the TTL in the same transaction', async () => {
    const fake = new FakeRedis();
    const clock = { now: START };
    const quota = quotaWith(fake, 5, clock);

    await quota.consume(ALICE);
    const window = Math.floor(START / HOUR_MS);
    const key = `irc:ratelimit:creategroup:${ALICE}:${window}`;

    expect(fake.commands).toEqual([`incr ${key}`, `pexpire ${key} ${HOUR_MS}`]);
    expect(fake.ttls.get(key)).toBe(HOUR_MS);
  });

  it('keeps users independent', async () => {
    const fake = new FakeRedis();
    const clock = { now: START };
    const quota = quotaWith(fake, 1, clock);

    expect(await quota.consume(ALICE)).toMatchObject({ allowed: true });
    expect(await quota.consume(ALICE)).toMatchObject({ allowed: false });
    expect(await quota.consume(BOB)).toMatchObject({ allowed: true });
    expect(await quota.consume(BOB)).toMatchObject({ allowed: false });
  });

  it('starts a fresh window after the hour rolls over', async () => {
    const fake = new FakeRedis();
    const clock = { now: START };
    const quota = quotaWith(fake, 1, clock);

    expect(await quota.consume(ALICE)).toMatchObject({ allowed: true });
    expect(await quota.consume(ALICE)).toMatchObject({ allowed: false });

    clock.now = START + HOUR_MS;
    await expect(quota.consume(ALICE)).resolves.toMatchObject({ allowed: true, used: 1 });
  });

  it('fails open when Redis throws (anti-abuse limit, not a security gate)', async () => {
    const fake = new FakeRedis();
    const clock = { now: START };
    const quota = quotaWith(fake, 1, clock);
    fake.failure = 'exec';

    await expect(quota.consume(ALICE)).resolves.toMatchObject({ allowed: true });
    // And again: a failure is not a denial that lingers.
    await expect(quota.consume(ALICE)).resolves.toMatchObject({ allowed: true });
  });

  it('fails open when the transaction returns a command error', async () => {
    const fake = new FakeRedis();
    const clock = { now: START };
    const quota = quotaWith(fake, 1, clock);
    fake.failure = 'result';

    await expect(quota.consume(ALICE)).resolves.toMatchObject({ allowed: true });
  });

  it('normalises the UUID so the key is stable', async () => {
    const fake = new FakeRedis();
    const clock = { now: START };
    const quota = quotaWith(fake, 5, clock);

    await quota.consume('  11111111-1111-4111-8111-111111111111  ');
    const window = Math.floor(START / HOUR_MS);
    expect(fake.commands[0]).toBe(`incr irc:ratelimit:creategroup:${ALICE}:${window}`);
  });

  it('is a no-op for an empty identity (defensive: the JWT guard runs first)', async () => {
    const fake = new FakeRedis();
    const quota = quotaWith(fake, 1, { now: START });

    await expect(quota.consume('   ')).resolves.toMatchObject({ allowed: true });
    expect(fake.commands).toEqual([]);
  });

  it('production factory reads config.createGroupPerHour and ctx.now()', async () => {
    const fake = new FakeRedis();
    const clock = { now: START };
    const config = loadConfig({
      MONGODB_URI: 'mongodb://127.0.0.1:27017',
      REDIS_URL: 'redis://127.0.0.1:16379',
      CREATE_GROUP_PER_HOUR: '2',
    } as NodeJS.ProcessEnv);
    const ctx: AppContext = {
      config,
      redis: fake as unknown as Redis,
      instanceId: 'test',
      now: () => clock.now,
    };

    const quota = createGroupCreationQuota(ctx);
    expect(await quota.consume(ALICE)).toMatchObject({ allowed: true, limit: 2 });
    expect(await quota.consume(ALICE)).toMatchObject({ allowed: true, limit: 2 });
    expect(await quota.consume(ALICE)).toMatchObject({ allowed: false, limit: 2 });
  });
});
