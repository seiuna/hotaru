import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import type { FilterRule } from '../../src/runtime/contracts.js';
import { IrcFilterRuleModel } from '../../src/modules/filters/model.js';
import { IrcGroupMemberModel, IrcGroupModel } from '../../src/modules/groups/model.js';
import { IrcAuditLogModel } from '../../src/modules/audit/model.js';
import { startRestHarness, testDbName, testMongoUri, type RestHarness } from './groups-rest-harness.js';

/**
 * HTTP-level coverage for the filter REST surface (design §13.2).
 *
 * Scope rules are the interesting part: a player manages their own rules, a group
 * manager manages that group's rules, and only a configured administrator may
 * touch the global rules. The evaluation itself (deny-first, allow-list) is covered
 * by `filters-service.test.ts`; here the point is who may write what.
 */

const OWNER = '11111111-1111-4111-8111-111111111111';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const OUTSIDER = '44444444-4444-4444-8444-444444444444';
const ADMIN = '99999999-9999-4999-8999-999999999999';

interface RulesBody {
  rules: FilterRule[];
}

describe('filters REST (integration, real app + real JWTs)', () => {
  let harness: RestHarness;

  beforeAll(async () => {
    await mongoose.connect(testMongoUri(), { dbName: testDbName(), serverSelectionTimeoutMS: 5_000 });
    await mongoose.connection.dropDatabase();
    await Promise.all([
      IrcFilterRuleModel.init(),
      IrcGroupModel.init(),
      IrcGroupMemberModel.init(),
      IrcAuditLogModel.init(),
    ]);

    harness = await startRestHarness({ adminUuids: [ADMIN] });
  }, 60_000);

  afterAll(async () => {
    await harness.close();
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await IrcFilterRuleModel.deleteMany({});
    await IrcGroupMemberModel.deleteMany({});
    await IrcGroupModel.deleteMany({});
    await IrcAuditLogModel.deleteMany({});
  });

  async function seededGroup(): Promise<string> {
    const created = await harness.call('POST', '/v1/groups', await harness.identity(OWNER), {
      name: 'Filter Group',
    });
    const groupId = (created.body as { group: { id: string } }).group.id;
    const invited = await harness.call('POST', `/v1/groups/${groupId}/members`, await harness.identity(OWNER), {
      userUuid: MEMBER,
    });
    expect(invited.status).toBe(201);
    return groupId;
  }

  describe('/v1/filters/me', () => {
    it('requires authentication', async () => {
      const response = await harness.call('GET', '/v1/filters/me');
      expect(response.status).toBe(401);
    });

    it('stores and returns the caller’s own rules', async () => {
      const put = await harness.call('PUT', '/v1/filters/me', await harness.identity(OWNER), {
        rules: [
          { pattern: 'chat.*', action: 'ALLOW' },
          { pattern: 'system.*', action: 'DENY' },
        ],
      });
      expect(put.status).toBe(200);
      const stored = (put.body as RulesBody).rules;
      expect(stored.map((rule) => rule.pattern)).toEqual(['chat.*', 'system.*']);
      expect(stored.every((rule) => rule.scope === 'USER')).toBe(true);
      expect(stored.every((rule) => rule.targetId === OWNER)).toBe(true);

      const get = await harness.call('GET', '/v1/filters/me', await harness.identity(OWNER));
      expect(get.status).toBe(200);
      expect((get.body as RulesBody).rules).toHaveLength(2);

      // Replacing with an empty list clears the rules.
      const cleared = await harness.call('PUT', '/v1/filters/me', await harness.identity(OWNER), { rules: [] });
      expect(cleared.status).toBe(200);
      expect((cleared.body as RulesBody).rules).toEqual([]);
    });

    it('rejects invalid patterns, reserved namespaces and oversized rule sets', async () => {
      const invalid = await harness.call('PUT', '/v1/filters/me', await harness.identity(OWNER), {
        rules: [{ pattern: 'not a pattern', action: 'DENY' }],
      });
      expect(invalid.status).toBe(400);
      expect(invalid.body).toMatchObject({ error: { code: 'INVALID_REQUEST' } });

      const reserved = await harness.call('PUT', '/v1/filters/me', await harness.identity(OWNER), {
        rules: [{ pattern: 'protocol.*', action: 'DENY' }],
      });
      expect(reserved.status).toBe(400);

      const tooMany = await harness.call('PUT', '/v1/filters/me', await harness.identity(OWNER), {
        rules: Array.from({ length: 101 }, (_, index) => ({
          pattern: `chat.rule${index}`,
          action: 'DENY',
        })),
      });
      expect(tooMany.status).toBe(400);
    });
  });

  describe('/v1/groups/:id/filters', () => {
    it('is readable by members and writable only by OWNER/ADMIN', async () => {
      const groupId = await seededGroup();

      const memberGet = await harness.call('GET', `/v1/groups/${groupId}/filters`, await harness.identity(MEMBER));
      expect(memberGet.status).toBe(200);
      expect((memberGet.body as RulesBody).rules).toEqual([]);

      const memberPut = await harness.call('PUT', `/v1/groups/${groupId}/filters`, await harness.identity(MEMBER), {
        rules: [{ pattern: 'chat.*', action: 'DENY' }],
      });
      expect(memberPut.status).toBe(403);
      expect(memberPut.body).toMatchObject({ error: { code: 'GROUP_ACCESS_DENIED' } });

      const ownerPut = await harness.call('PUT', `/v1/groups/${groupId}/filters`, await harness.identity(OWNER), {
        rules: [{ pattern: 'chat.*', action: 'DENY' }],
      });
      expect(ownerPut.status).toBe(200);
      expect((ownerPut.body as RulesBody).rules[0]).toMatchObject({
        scope: 'GROUP',
        targetId: groupId,
        pattern: 'chat.*',
        action: 'DENY',
      });
    });

    it('hides the rules of a group from non-members', async () => {
      const groupId = await seededGroup();
      const response = await harness.call('GET', `/v1/groups/${groupId}/filters`, await harness.identity(OUTSIDER));
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ error: { code: 'GROUP_NOT_FOUND' } });
    });
  });

  describe('/v1/admin/filters/global', () => {
    it('is gated on the administrator UUID list', async () => {
      const denied = await harness.call('GET', '/v1/admin/filters/global', await harness.identity(OWNER));
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({ error: { code: 'FORBIDDEN' } });

      const deniedPut = await harness.call('PUT', '/v1/admin/filters/global', await harness.identity(OWNER), {
        rules: [{ pattern: '*', action: 'DENY' }],
      });
      expect(deniedPut.status).toBe(403);
    });

    it('lets an administrator read and replace the global rules', async () => {
      const initial = await harness.call('GET', '/v1/admin/filters/global', await harness.identity(ADMIN));
      expect(initial.status).toBe(200);
      expect((initial.body as RulesBody).rules).toEqual([]);

      const put = await harness.call('PUT', '/v1/admin/filters/global', await harness.identity(ADMIN), {
        rules: [{ pattern: 'chat.*', action: 'DENY' }],
      });
      expect(put.status).toBe(200);
      expect((put.body as RulesBody).rules[0]).toMatchObject({
        scope: 'GLOBAL',
        targetId: null,
        pattern: 'chat.*',
      });

      const get = await harness.call('GET', '/v1/admin/filters/global', await harness.identity(ADMIN));
      expect((get.body as RulesBody).rules).toHaveLength(1);
    });
  });

  it('records an audit event for every ruleset replacement', async () => {
    await harness.call('PUT', '/v1/filters/me', await harness.identity(OWNER), {
      rules: [{ pattern: 'chat.*', action: 'DENY' }],
    });

    const entries = await IrcAuditLogModel.find({ event: 'filter.rules.updated' }).lean().exec();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actorUuid: OWNER, targetType: 'user', targetId: OWNER });
    expect(entries[0]?.metadata).toMatchObject({ scope: 'USER', ruleCount: 1 });
  });
});
