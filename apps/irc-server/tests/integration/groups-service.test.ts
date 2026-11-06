import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import type { Redis } from 'ioredis';
import { loadConfig } from '../../src/config/env.js';
import type { AppContext } from '../../src/context.js';
import type { GroupService } from '../../src/runtime/contracts.js';
import { createGroupService } from '../../src/modules/groups/service.js';
import { IrcGroupMemberModel, IrcGroupModel } from '../../src/modules/groups/model.js';

/**
 * Integration coverage for the group service against a real MongoDB
 * (`mongodb://127.0.0.1:27017`, database `skymatrix_irc_test`).
 *
 * These tests exist because the mockable parts of the service are trivial: the
 * interesting behaviour is unique-index idempotency, capability checks across
 * three roles, and hiding a group from non-members. A fake would test the fake.
 *
 * Run with `pnpm --filter @skymatrix/irc-server test:integration` after
 * `docker start skymatrix-mongo skymatrix-redis`.
 */

const MONGO_URI = process.env['IRC_TEST_MONGODB_URI'] ?? 'mongodb://127.0.0.1:27017';
const DB_NAME = 'skymatrix_irc_test';

const OWNER = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const OUTSIDER = '44444444-4444-4444-8444-444444444444';
const EXTRA = '55555555-5555-4555-8555-555555555555';

function makeCtx(): AppContext {
  const config = loadConfig({
    NODE_ENV: 'test',
    MONGODB_URI: MONGO_URI,
    MONGODB_DB: DB_NAME,
    REDIS_URL: 'redis://127.0.0.1:16379',
    MAX_GROUP_MEMBERS: '5',
  } as NodeJS.ProcessEnv);

  return {
    config,
    // The group service never touches Redis; the contract only needs the field.
    redis: {} as unknown as Redis,
    instanceId: 'test-instance',
    now: () => Date.now(),
  };
}

async function expectAppError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: 'AppError', code });
}

describe('GroupService (integration)', () => {
  let groups: GroupService;

  beforeAll(async () => {
    await mongoose.connect(`${MONGO_URI}/${DB_NAME}`, { dbName: DB_NAME, serverSelectionTimeoutMS: 5_000 });
    await mongoose.connection.dropDatabase();
    // Build the unique indexes before the idempotency tests rely on them.
    await Promise.all([IrcGroupModel.init(), IrcGroupMemberModel.init()]);
  }, 30_000);

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await IrcGroupMemberModel.deleteMany({});
    await IrcGroupModel.deleteMany({});
    groups = createGroupService(makeCtx());
  });

  /** Creates a group owned by OWNER with MEMBER joined. */
  async function seedGroup(overrides: { maxMembers?: number; visibility?: 'PRIVATE' | 'PUBLIC' } = {}) {
    const group = await groups.createGroup({
      ownerUuid: OWNER,
      name: 'Night Owls',
      ...(overrides.maxMembers === undefined ? {} : { maxMembers: overrides.maxMembers }),
    });
    if (overrides.visibility === 'PUBLIC') {
      await groups.updateGroup(group.id, OWNER, { visibility: 'PUBLIC' });
    }
    await groups.addMember(group.id, OWNER, MEMBER);
    return group;
  }

  describe('createGroup', () => {
    it('creates an opaque id, the owner membership and an ACTIVE summary', async () => {
      const group = await groups.createGroup({ ownerUuid: OWNER, name: '  Night   Owls  ' });

      expect(group.id).toMatch(/^grp_[A-Za-z0-9_-]{8,}$/);
      expect(group.id).not.toMatch(/^[0-9a-f]{24}$/);
      expect(group.name).toBe('Night Owls');
      expect(group.ownerUuid).toBe(OWNER);
      expect(group.visibility).toBe('PRIVATE');
      expect(group.maxMembers).toBe(5); // config MAX_GROUP_MEMBERS
      expect(group.status).toBe('ACTIVE');
      expect(Number.isNaN(Date.parse(group.createdAt))).toBe(false);

      const owner = await groups.membership(group.id, OWNER);
      expect(owner).toMatchObject({ groupId: group.id, userUuid: OWNER, role: 'OWNER' });
    });

    it('canonicalises an undashed/uppercase owner UUID', async () => {
      const group = await groups.createGroup({
        ownerUuid: '11111111111141118111111111111111',
        name: 'Canon',
      });
      expect(group.ownerUuid).toBe(OWNER);
      expect(await groups.membership(group.id, OWNER)).not.toBeNull();
    });

    it('tolerates duplicate names (the id is the identity)', async () => {
      const first = await groups.createGroup({ ownerUuid: OWNER, name: 'Same Name' });
      const second = await groups.createGroup({ ownerUuid: OWNER, name: 'Same Name' });
      expect(first.id).not.toBe(second.id);

      const mine = await groups.listGroupsForUser(OWNER);
      expect(mine.filter((group) => group.name === 'Same Name')).toHaveLength(2);
    });

    it('rejects empty and oversized names', async () => {
      await expectAppError(groups.createGroup({ ownerUuid: OWNER, name: '   ' }), 'INVALID_REQUEST');
      await expectAppError(
        groups.createGroup({ ownerUuid: OWNER, name: 'x'.repeat(65) }),
        'INVALID_REQUEST',
      );
    });

    it('enforces the configured member cap', async () => {
      await expectAppError(
        groups.createGroup({ ownerUuid: OWNER, name: 'Too Big', maxMembers: 6 }),
        'INVALID_REQUEST',
      );
      await expectAppError(
        groups.createGroup({ ownerUuid: OWNER, name: 'Too Small', maxMembers: 1 }),
        'INVALID_REQUEST',
      );
      const group = await groups.createGroup({ ownerUuid: OWNER, name: 'Fits', maxMembers: 3 });
      expect(group.maxMembers).toBe(3);
    });
  });

  describe('listGroupsForUser / getGroup', () => {
    it('lists only the caller’s active groups', async () => {
      const first = await seedGroup();
      const second = await groups.createGroup({ ownerUuid: OWNER, name: 'Second' });

      const ownerGroups = await groups.listGroupsForUser(OWNER);
      expect(ownerGroups.map((group) => group.id).sort()).toEqual([first.id, second.id].sort());

      const memberGroups = await groups.listGroupsForUser(MEMBER);
      expect(memberGroups.map((group) => group.id)).toEqual([first.id]);

      expect(await groups.listGroupsForUser(OUTSIDER)).toEqual([]);
    });

    it('returns the group to a member and hides it from everyone else — even when PUBLIC', async () => {
      const group = await seedGroup({ visibility: 'PUBLIC' });

      await expect(groups.getGroup(group.id, MEMBER)).resolves.toMatchObject({ id: group.id });
      // A non-member gets the same answer as for a nonexistent id: no existence oracle.
      await expectAppError(groups.getGroup(group.id, OUTSIDER), 'GROUP_NOT_FOUND');
      await expectAppError(groups.getGroup('grp_doesnotexist', MEMBER), 'GROUP_NOT_FOUND');
    });

    it('hides a deleted group', async () => {
      const group = await seedGroup();
      await groups.deleteGroup(group.id, OWNER);
      await expectAppError(groups.getGroup(group.id, OWNER), 'GROUP_NOT_FOUND');
      expect(await groups.listGroupsForUser(OWNER)).toEqual([]);
    });
  });

  describe('updateGroup', () => {
    it('lets OWNER and ADMIN rename / change visibility / raise the cap', async () => {
      const group = await seedGroup();
      await groups.addMember(group.id, OWNER, ADMIN, 'ADMIN');

      await expect(
        groups.updateGroup(group.id, ADMIN, { name: 'Renamed By Admin' }),
      ).resolves.toMatchObject({ name: 'Renamed By Admin' });

      const updated = await groups.updateGroup(group.id, OWNER, {
        visibility: 'PUBLIC',
        maxMembers: 4,
      });
      expect(updated.visibility).toBe('PUBLIC');
      expect(updated.maxMembers).toBe(4);
    });

    it('refuses a plain member', async () => {
      const group = await seedGroup();
      await expectAppError(groups.updateGroup(group.id, MEMBER, { name: 'Nope' }), 'FORBIDDEN');
    });

    it('refuses a non-member with GROUP_ACCESS_DENIED (write endpoint)', async () => {
      const group = await seedGroup();
      await expectAppError(groups.updateGroup(group.id, OUTSIDER, { name: 'Nope' }), 'GROUP_ACCESS_DENIED');
    });

    it('rejects an empty patch and a cap below the current member count', async () => {
      const group = await seedGroup();
      await expectAppError(groups.updateGroup(group.id, OWNER, {}), 'INVALID_REQUEST');
      // owner + member = 2 members, so 2 is allowed and 1 is not representable at all
      await expect(groups.updateGroup(group.id, OWNER, { maxMembers: 2 })).resolves.toMatchObject({
        maxMembers: 2,
      });
      await expectAppError(groups.updateGroup(group.id, OWNER, { maxMembers: 1 }), 'INVALID_REQUEST');
    });
  });

  describe('deleteGroup', () => {
    it('is OWNER-only and removes the memberships', async () => {
      const group = await seedGroup();
      await groups.addMember(group.id, OWNER, ADMIN, 'ADMIN');

      await expectAppError(groups.deleteGroup(group.id, ADMIN), 'FORBIDDEN');
      await expectAppError(groups.deleteGroup(group.id, MEMBER), 'FORBIDDEN');
      await expectAppError(groups.deleteGroup(group.id, OUTSIDER), 'GROUP_ACCESS_DENIED');

      await groups.deleteGroup(group.id, OWNER);
      expect(await groups.membership(group.id, OWNER)).toBeNull();
      expect(await groups.memberUuids(group.id)).toEqual([]);
      // Soft-deleted, not physically removed (the audit trail keeps pointing at it).
      const doc = await IrcGroupModel.findOne({ groupId: group.id }).lean().exec();
      expect(doc?.status).toBe('DELETED');
    });
  });

  describe('addMember', () => {
    it('is idempotent and never changes an existing role', async () => {
      const group = await seedGroup();
      const first = await groups.addMember(group.id, OWNER, EXTRA);
      const again = await groups.addMember(group.id, OWNER, EXTRA, 'ADMIN');

      expect(first).toMatchObject({ userUuid: EXTRA, role: 'MEMBER' });
      expect(again).toMatchObject({ userUuid: EXTRA, role: 'MEMBER' });
      expect(await groups.memberUuids(group.id)).toEqual([OWNER, MEMBER, EXTRA]);
    });

    it('allows OWNER to add an ADMIN, but an ADMIN to add only MEMBERs', async () => {
      const group = await seedGroup();
      await groups.addMember(group.id, OWNER, ADMIN, 'ADMIN');

      await expectAppError(groups.addMember(group.id, ADMIN, EXTRA, 'ADMIN'), 'FORBIDDEN');
      await expect(groups.addMember(group.id, ADMIN, EXTRA)).resolves.toMatchObject({ role: 'MEMBER' });
    });

    it('refuses a plain member and a non-member', async () => {
      const group = await seedGroup();
      await expectAppError(groups.addMember(group.id, MEMBER, EXTRA), 'FORBIDDEN');
      await expectAppError(groups.addMember(group.id, OUTSIDER, EXTRA), 'GROUP_ACCESS_DENIED');
    });

    it('rejects a malformed target UUID', async () => {
      const group = await seedGroup();
      await expectAppError(groups.addMember(group.id, OWNER, 'not-a-uuid'), 'INVALID_REQUEST');
    });

    it('enforces the member cap with CONFLICT', async () => {
      const group = await seedGroup({ maxMembers: 2 });
      expect(await groups.memberUuids(group.id)).toHaveLength(2);
      await expectAppError(groups.addMember(group.id, OWNER, EXTRA), 'CONFLICT');
    });
  });

  describe('removeMember', () => {
    it('lets the owner remove members and admins, and refuses to remove itself', async () => {
      const group = await seedGroup();
      await groups.addMember(group.id, OWNER, ADMIN, 'ADMIN');

      await groups.removeMember(group.id, OWNER, MEMBER);
      expect(await groups.membership(group.id, MEMBER)).toBeNull();

      await groups.removeMember(group.id, OWNER, ADMIN);
      expect(await groups.membership(group.id, ADMIN)).toBeNull();

      // The owner cannot leave; there is no ownership transfer in v1.
      await expectAppError(groups.removeMember(group.id, OWNER, OWNER), 'FORBIDDEN');
    });

    it('lets an admin remove members but not peers or the owner, and lets anyone but the owner leave', async () => {
      const group = await seedGroup();
      await groups.addMember(group.id, OWNER, ADMIN, 'ADMIN');
      await groups.addMember(group.id, OWNER, EXTRA);

      await groups.removeMember(group.id, ADMIN, EXTRA); // admin removes a member
      expect(await groups.membership(group.id, EXTRA)).toBeNull();

      await expectAppError(groups.removeMember(group.id, ADMIN, OWNER), 'FORBIDDEN');
      // Leaving is allowed for everyone except the owner, admins included.
      await groups.removeMember(group.id, ADMIN, ADMIN);
      expect(await groups.membership(group.id, ADMIN)).toBeNull();

      await groups.removeMember(group.id, MEMBER, MEMBER); // member leaves
      expect(await groups.membership(group.id, MEMBER)).toBeNull();
    });

    it('reports a missing member and a non-member actor', async () => {
      const group = await seedGroup();
      await expectAppError(groups.removeMember(group.id, OWNER, EXTRA), 'NOT_FOUND');
      await expectAppError(groups.removeMember(group.id, OUTSIDER, MEMBER), 'GROUP_ACCESS_DENIED');
    });
  });

  describe('setMemberRole', () => {
    it('is OWNER-only and supports MEMBER <-> ADMIN', async () => {
      const group = await seedGroup();
      await groups.addMember(group.id, OWNER, ADMIN, 'ADMIN');

      await expectAppError(groups.setMemberRole(group.id, MEMBER, MEMBER, 'ADMIN'), 'FORBIDDEN');
      await expectAppError(groups.setMemberRole(group.id, ADMIN, MEMBER, 'ADMIN'), 'FORBIDDEN');
      // A non-member cannot reach the role check at all.
      await expectAppError(groups.setMemberRole(group.id, OUTSIDER, MEMBER, 'ADMIN'), 'GROUP_ACCESS_DENIED');

      await expect(groups.setMemberRole(group.id, OWNER, MEMBER, 'ADMIN')).resolves.toMatchObject({
        role: 'ADMIN',
      });
      await expect(groups.setMemberRole(group.id, OWNER, MEMBER, 'MEMBER')).resolves.toMatchObject({
        role: 'MEMBER',
      });
      // Idempotent re-apply.
      await expect(groups.setMemberRole(group.id, OWNER, MEMBER, 'MEMBER')).resolves.toMatchObject({
        role: 'MEMBER',
      });
    });

    it('rejects OWNER (no transfer in v1) and self-changes', async () => {
      const group = await seedGroup();
      await expectAppError(groups.setMemberRole(group.id, OWNER, MEMBER, 'OWNER'), 'INVALID_REQUEST');
      await expectAppError(groups.setMemberRole(group.id, OWNER, OWNER, 'ADMIN'), 'FORBIDDEN');
      // A role change for a non-member is a 404, not a silent no-op.
      await expectAppError(groups.setMemberRole(group.id, OWNER, EXTRA, 'ADMIN'), 'NOT_FOUND');
    });
  });

  describe('membership / memberUuids', () => {
    it('returns null for unknown or empty inputs instead of throwing', async () => {
      expect(await groups.membership('grp_missing', OWNER)).toBeNull();
      expect(await groups.membership('', OWNER)).toBeNull();
      expect(await groups.membership('grp_whatever', '')).toBeNull();
      expect(await groups.memberUuids('grp_missing')).toEqual([]);
    });

    it('answers by canonical UUID regardless of the input form', async () => {
      const group = await seedGroup();
      expect(await groups.membership(group.id, '33333333333343338333333333333333')).toMatchObject({
        userUuid: MEMBER,
        role: 'MEMBER',
      });
      expect(await groups.memberUuids(group.id)).toEqual([OWNER, MEMBER]);
    });
  });
});
