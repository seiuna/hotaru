import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { IrcGroupMemberModel, IrcGroupModel } from '../../src/modules/groups/model.js';
import { startRestHarness, testDbName, testMongoUri, type RestHarness } from './groups-rest-harness.js';

/**
 * HTTP coverage for `config.createGroupPerHour` (429 path), using a fake
 * `ctx.redis` so the quota can be exhausted deterministically and then made to
 * fail — the fail-open requirement is only observable with a broken Redis.
 *
 * Player UUIDs are random per run on purpose: the real suites share Redis, but
 * this one owns its counter, so nothing can leak between runs.
 */

interface FakePipeline {
  incr(key: string): FakePipeline;
  pexpire(key: string, ms: number): FakePipeline;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

class FakeQuotaRedis {
  private readonly counts = new Map<string, number>();
  fail = false;

  /** Only used by `requireAuth`'s session-revocation check. */
  async exists(): Promise<number> {
    return 0;
  }

  multi(): FakePipeline {
    const operations: Array<() => unknown> = [];
    const pipeline: FakePipeline = {
      incr: (key: string) => {
        operations.push(() => {
          const next = (this.counts.get(key) ?? 0) + 1;
          this.counts.set(key, next);
          return next;
        });
        return pipeline;
      },
      pexpire: () => {
        operations.push(() => 1);
        return pipeline;
      },
      exec: async () => {
        if (this.fail) throw new Error('redis is down');
        return operations.map((operation) => [null, operation()] as [null, unknown]);
      },
    };
    return pipeline;
  }
}

describe('POST /v1/groups quota (integration, fake Redis)', () => {
  let harness: RestHarness;
  let redis: FakeQuotaRedis;

  beforeAll(async () => {
    await mongoose.connect(testMongoUri(), { dbName: testDbName(), serverSelectionTimeoutMS: 5_000 });
    await mongoose.connection.dropDatabase();
    await Promise.all([IrcGroupModel.init(), IrcGroupMemberModel.init()]);

    redis = new FakeQuotaRedis();
    harness = await startRestHarness({ createGroupPerHour: 2, redis });
  }, 60_000);

  afterAll(async () => {
    await harness.close();
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await IrcGroupMemberModel.deleteMany({});
    await IrcGroupModel.deleteMany({});
  });

  it('allows N creations, then answers 429 RATE_LIMITED with a retry hint', async () => {
    const player = randomUUID();
    const identity = await harness.identity(player);

    const first = await harness.call('POST', '/v1/groups', identity, { name: 'First' });
    expect(first.status).toBe(201);

    const second = await harness.call('POST', '/v1/groups', identity, { name: 'Second' });
    expect(second.status).toBe(201);

    const third = await harness.call('POST', '/v1/groups', identity, { name: 'Third' });
    expect(third.status).toBe(429);
    expect(third.body).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect((third.body as { error: { message: string } }).error.message).toMatch(/try again in \d+ seconds/);
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);

    // The denied attempt must not have created anything.
    const list = await harness.call('GET', '/v1/groups', identity);
    expect((list.body as { groups: unknown[] }).groups).toHaveLength(2);
  });

  it('keeps the quota per player', async () => {
    const alice = await harness.identity(randomUUID());
    const bob = await harness.identity(randomUUID());

    expect((await harness.call('POST', '/v1/groups', alice, { name: 'A1' })).status).toBe(201);
    expect((await harness.call('POST', '/v1/groups', alice, { name: 'A2' })).status).toBe(201);
    expect((await harness.call('POST', '/v1/groups', alice, { name: 'A3' })).status).toBe(429);

    expect((await harness.call('POST', '/v1/groups', bob, { name: 'B1' })).status).toBe(201);
  });

  it('fails open when Redis is unavailable', async () => {
    const player = await harness.identity(randomUUID());
    redis.fail = true;

    try {
      const created = await harness.call('POST', '/v1/groups', player, { name: 'Redisless' });
      expect(created.status).toBe(201);
      expect((created.body as { group: { ownerUuid: string } }).group.ownerUuid).toBe(
        player.minecraftUuid.toLowerCase(),
      );
    } finally {
      redis.fail = false;
    }
  });
});
