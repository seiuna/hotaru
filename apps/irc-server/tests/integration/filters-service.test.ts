import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import type { Redis } from 'ioredis';
import { loadConfig } from '../../src/config/env.js';
import type { AppContext } from '../../src/context.js';
import type { FilterService } from '../../src/runtime/contracts.js';
import { createFilterService } from '../../src/modules/filters/service.js';
import { IrcFilterRuleModel } from '../../src/modules/filters/model.js';

/**
 * Integration coverage for the filter service against a real MongoDB
 * (`mongodb://127.0.0.1:27017`, database `skymatrix_irc_test`).
 *
 * What matters here is not "does a query work" but the security-relevant
 * composition: deny-first precedence across scopes, allow-list mode, cache
 * staleness bounds, and the guarantee that a rejected replacement never leaves the
 * stored ruleset half-written.
 *
 * Run with `pnpm --filter @skymatrix/irc-server test:integration` after
 * `docker start skymatrix-mongo skymatrix-redis`.
 */

const MONGO_URI = process.env['IRC_TEST_MONGODB_URI'] ?? 'mongodb://127.0.0.1:27017';
const DB_NAME = 'skymatrix_irc_test';

const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ALICE_UNDASHED = ALICE.replace(/-/g, '');
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GROUP = 'grp_abcdefghijklmnop';

function makeCtx(clock: { now: number }): AppContext {
  const config = loadConfig({
    NODE_ENV: 'test',
    MONGODB_URI: MONGO_URI,
    MONGODB_DB: DB_NAME,
    REDIS_URL: 'redis://127.0.0.1:16379',
  } as NodeJS.ProcessEnv);

  return {
    config,
    redis: {} as unknown as Redis,
    instanceId: 'test-instance',
    now: () => clock.now,
  };
}

async function expectAppError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: 'AppError', code });
}

describe('FilterService (integration)', () => {
  let filters: FilterService;
  let clock: { now: number };

  beforeAll(async () => {
    await mongoose.connect(`${MONGO_URI}/${DB_NAME}`, { dbName: DB_NAME, serverSelectionTimeoutMS: 5_000 });
    await mongoose.connection.dropDatabase();
    await IrcFilterRuleModel.init();
  }, 30_000);

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await IrcFilterRuleModel.deleteMany({});
    clock = { now: 1_700_000_000_000 };
    filters = createFilterService(makeCtx(clock));
  });

  describe('replaceRules / listRules', () => {
    it('stores a full ruleset and returns it in a stable order', async () => {
      const stored = await filters.replaceRules(
        'USER',
        ALICE,
        [
          { pattern: 'system.*', action: 'DENY' },
          { pattern: 'chat.*', action: 'ALLOW' },
        ],
        ALICE,
      );

      expect(stored.map((rule) => rule.pattern)).toEqual(['chat.*', 'system.*']);
      expect(stored.every((rule) => rule.scope === 'USER')).toBe(true);
      expect(stored.every((rule) => rule.targetId === ALICE)).toBe(true);
      expect(stored.every((rule) => rule.enabled)).toBe(true);

      const listed = await filters.listRules('USER', ALICE);
      expect(listed).toHaveLength(2);
      expect(listed[0]?.createdAt).toBe(new Date(clock.now).toISOString());
    });

    it('is idempotent: re-applying the same set keeps the rows', async () => {
      const rules = [{ pattern: 'chat.*', action: 'DENY' as const }];
      const first = await filters.replaceRules('USER', ALICE, rules, ALICE);
      const second = await filters.replaceRules('USER', ALICE, rules, ALICE);

      expect(second.map((rule) => rule.id)).toEqual(first.map((rule) => rule.id));
      expect(await IrcFilterRuleModel.countDocuments({ scope: 'USER', targetId: ALICE })).toBe(1);
    });

    it('prunes rules that are no longer in the replacement set', async () => {
      await filters.replaceRules(
        'USER',
        ALICE,
        [
          { pattern: 'chat.*', action: 'DENY' },
          { pattern: 'system.*', action: 'DENY' },
        ],
        ALICE,
      );
      await filters.replaceRules('USER', ALICE, [{ pattern: 'chat.*', action: 'DENY' }], ALICE);

      const listed = await filters.listRules('USER', ALICE);
      expect(listed.map((rule) => rule.pattern)).toEqual(['chat.*']);
    });

    it('rejects the whole replacement before writing when any pattern is invalid', async () => {
      await filters.replaceRules('USER', ALICE, [{ pattern: 'chat.*', action: 'DENY' }], ALICE);

      await expectAppError(
        filters.replaceRules(
          'USER',
          ALICE,
          [
            { pattern: 'system.*', action: 'DENY' },
            { pattern: 'not a pattern', action: 'DENY' },
          ],
          ALICE,
        ),
        'INVALID_REQUEST',
      );

      // Failure is atomic from the caller's point of view: the old set survives.
      const listed = await filters.listRules('USER', ALICE);
      expect(listed.map((rule) => rule.pattern)).toEqual(['chat.*']);
    });

    it('rejects reserved namespaces and duplicate patterns', async () => {
      await expectAppError(
        filters.replaceRules('USER', ALICE, [{ pattern: 'protocol.*', action: 'DENY' }], ALICE),
        'INVALID_REQUEST',
      );
      await expectAppError(
        filters.replaceRules('USER', ALICE, [{ pattern: 'srp.ready', action: 'DENY' }], ALICE),
        'INVALID_REQUEST',
      );
      await expectAppError(
        filters.replaceRules(
          'USER',
          ALICE,
          [
            { pattern: 'chat.*', action: 'DENY' },
            { pattern: 'chat.*', action: 'ALLOW' },
          ],
          ALICE,
        ),
        'INVALID_REQUEST',
      );
    });

    it('requires an authenticated actor', async () => {
      await expectAppError(
        filters.replaceRules('USER', ALICE, [{ pattern: 'chat.*', action: 'DENY' }], '   '),
        'UNAUTHORIZED',
      );
      expect(await filters.listRules('USER', ALICE)).toEqual([]);
    });

    it('normalises the scope target (GLOBAL has none, GROUP/USER require one)', async () => {
      await expectAppError(
        filters.replaceRules('GLOBAL', GROUP, [{ pattern: 'chat.*', action: 'DENY' }], ALICE),
        'INVALID_REQUEST',
      );
      await expectAppError(
        filters.replaceRules('GROUP', null, [{ pattern: 'chat.*', action: 'DENY' }], ALICE),
        'INVALID_REQUEST',
      );

      const global = await filters.replaceRules('GLOBAL', null, [{ pattern: '*', action: 'DENY' }], ALICE);
      expect(global[0]).toMatchObject({ scope: 'GLOBAL', targetId: null });

      // USER targets are canonicalised, so the undashed form addresses the same rules.
      await filters.replaceRules('USER', ALICE_UNDASHED, [{ pattern: 'chat.*', action: 'DENY' }], ALICE);
      const listed = await filters.listRules('USER', ALICE);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.targetId).toBe(ALICE);
    });
  });

  describe('deny-first evaluation', () => {
    it('a global deny applies to every route mode', async () => {
      await filters.replaceRules('GLOBAL', null, [{ pattern: 'chat.*', action: 'DENY' }], ALICE);
      expect(await filters.isGloballyDenied('chat.message')).toBe(true);
      expect(await filters.isGloballyDenied('system.ping')).toBe(false);
    });

    it('a global deny cannot be overridden by a per-user allow', async () => {
      await filters.replaceRules('GLOBAL', null, [{ pattern: 'chat.*', action: 'DENY' }], ALICE);
      await filters.replaceRules('USER', ALICE, [{ pattern: 'chat.*', action: 'ALLOW' }], ALICE);

      expect(await filters.isGloballyDenied('chat.message')).toBe(true);
      // The user scope itself does not deny, but the router checks global first.
      expect(await filters.isUserDenied(ALICE, 'chat.message')).toBe(false);
    });

    it('group rules apply only to that group', async () => {
      await filters.replaceRules('GROUP', GROUP, [{ pattern: 'chat.*', action: 'DENY' }], ALICE);
      expect(await filters.isGroupDenied(GROUP, 'chat.message')).toBe(true);
      expect(await filters.isGroupDenied('grp_othergroup1', 'chat.message')).toBe(false);
      expect(await filters.isGroupDenied('', 'chat.message')).toBe(false);
    });

    it('per-user rules deny only for that user', async () => {
      await filters.replaceRules('USER', ALICE, [{ pattern: 'chat.alert', action: 'DENY' }], ALICE);
      expect(await filters.isUserDenied(ALICE, 'chat.alert')).toBe(true);
      expect(await filters.isUserDenied(ALICE, 'chat.message')).toBe(false);
      expect(await filters.isUserDenied(BOB, 'chat.alert')).toBe(false);
    });

    it('a scope with only ALLOW rules becomes an allow-list', async () => {
      await filters.replaceRules('USER', ALICE, [{ pattern: 'chat.*', action: 'ALLOW' }], ALICE);
      expect(await filters.isUserDenied(ALICE, 'chat.message')).toBe(false);
      expect(await filters.isUserDenied(ALICE, 'system.ping')).toBe(true);
    });

    it('a matching DENY wins over a matching ALLOW in the same scope', async () => {
      // Stored directly: the API rejects duplicate patterns by design, but a legacy
      // or imported row must still evaluate deny-first.
      await IrcFilterRuleModel.create([
        { scope: 'USER', targetId: ALICE, pattern: '*', action: 'ALLOW', enabled: true },
        { scope: 'USER', targetId: ALICE, pattern: 'chat.*', action: 'DENY', enabled: true },
      ]);

      expect(await filters.isUserDenied(ALICE, 'chat.message')).toBe(true);
      expect(await filters.isUserDenied(ALICE, 'system.ping')).toBe(false);
    });

    it('ignores disabled rules', async () => {
      await IrcFilterRuleModel.create({
        scope: 'USER',
        targetId: ALICE,
        pattern: 'chat.*',
        action: 'DENY',
        enabled: false,
      });
      expect(await filters.isUserDenied(ALICE, 'chat.message')).toBe(false);
    });
  });

  describe('cache', () => {
    it('serves a ruleset from memory until the TTL expires', async () => {
      await filters.replaceRules('USER', ALICE, [{ pattern: 'chat.a', action: 'DENY' }], ALICE);
      expect(await filters.isUserDenied(ALICE, 'chat.a')).toBe(true);

      // Simulate another node writing a rule: this process must not see it until
      // its cache entry expires (bounded staleness).
      clock.now += 1_000;
      await IrcFilterRuleModel.create({
        scope: 'USER',
        targetId: ALICE,
        pattern: 'chat.b',
        action: 'DENY',
      });
      expect(await filters.isUserDenied(ALICE, 'chat.b')).toBe(false);

      clock.now += 5_000;
      expect(await filters.isUserDenied(ALICE, 'chat.b')).toBe(true);
    });

    it('applies a local replacement immediately', async () => {
      await filters.replaceRules('USER', ALICE, [{ pattern: 'chat.*', action: 'DENY' }], ALICE);
      expect(await filters.isUserDenied(ALICE, 'chat.message')).toBe(true);

      await filters.replaceRules('USER', ALICE, [], ALICE);
      expect(await filters.isUserDenied(ALICE, 'chat.message')).toBe(false);
    });

    it('keeps scopes independent', async () => {
      await filters.replaceRules('USER', ALICE, [{ pattern: 'chat.*', action: 'DENY' }], ALICE);
      await filters.replaceRules('USER', BOB, [], ALICE);

      expect(await filters.isUserDenied(ALICE, 'chat.message')).toBe(true);
      expect(await filters.isUserDenied(BOB, 'chat.message')).toBe(false);
    });
  });
});
