import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import type { GroupSummary } from '../../src/runtime/contracts.js';
import { IrcGroupMemberModel, IrcGroupModel } from '../../src/modules/groups/model.js';
import { IrcAuditLogModel } from '../../src/modules/audit/model.js';
import { startRestHarness, testDbName, testMongoUri, type RestHarness } from './groups-rest-harness.js';

/**
 * HTTP-level coverage for the group REST surface (`design §13.1`).
 *
 * The service is already covered by `groups-service.test.ts`; this suite proves
 * the wiring around it: `requireAuth` rejects anonymous callers, the Zod schemas
 * produce 400s, the error handler maps `AppError` to the documented body, response
 * serialisation keeps the documented shape, and the audit trail is written.
 */

const OWNER = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const OUTSIDER = '44444444-4444-4444-8444-444444444444';

interface GroupBody {
  group: GroupSummary;
}

interface MemberBody {
  member: { groupId: string; userUuid: string; role: string; joinedAt: string };
}

describe('groups REST (integration, real app + real JWTs)', () => {
  let harness: RestHarness;

  beforeAll(async () => {
    await mongoose.connect(testMongoUri(), { dbName: testDbName(), serverSelectionTimeoutMS: 5_000 });
    await mongoose.connection.dropDatabase();
    await Promise.all([
      IrcGroupModel.init(),
      IrcGroupMemberModel.init(),
      IrcAuditLogModel.init(),
    ]);

    harness = await startRestHarness();
  }, 60_000);

  afterAll(async () => {
    await harness.close();
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await IrcGroupMemberModel.deleteMany({});
    await IrcGroupModel.deleteMany({});
    await IrcAuditLogModel.deleteMany({});
  });

  /** Creates a group as OWNER and invites MEMBER; returns the group id. */
  async function seededGroup(): Promise<string> {
    const created = await harness.call('POST', '/v1/groups', await harness.identity(OWNER), {
      name: 'Night Owls',
    });
    expect(created.status).toBe(201);
    const groupId = (created.body as GroupBody).group.id;

    const invited = await harness.call('POST', `/v1/groups/${groupId}/members`, await harness.identity(OWNER), {
      userUuid: MEMBER,
    });
    expect(invited.status).toBe(201);
    return groupId;
  }

  it('rejects anonymous callers with 401 UNAUTHORIZED', async () => {
    const list = await harness.call('GET', '/v1/groups');
    expect(list.status).toBe(401);
    expect(list.body).toMatchObject({ error: { code: 'UNAUTHORIZED' } });

    const create = await harness.call('POST', '/v1/groups', null, { name: 'Nope' });
    expect(create.status).toBe(401);
  });

  it('creates a group, exposes the documented summary and lists it for the owner', async () => {
    const created = await harness.call('POST', '/v1/groups', await harness.identity(OWNER), {
      name: '  Night   Owls ',
      maxMembers: 4,
    });

    expect(created.status).toBe(201);
    const group = (created.body as GroupBody).group;
    expect(group.id).toMatch(/^grp_/);
    expect(group).toMatchObject({
      name: 'Night Owls',
      ownerUuid: OWNER,
      visibility: 'PRIVATE',
      maxMembers: 4,
      status: 'ACTIVE',
    });
    expect(Number.isNaN(Date.parse(group.createdAt))).toBe(false);

    const list = await harness.call('GET', '/v1/groups', await harness.identity(OWNER));
    expect(list.status).toBe(200);
    expect((list.body as { groups: GroupSummary[] }).groups.map((item) => item.id)).toEqual([group.id]);

    const detail = await harness.call('GET', `/v1/groups/${group.id}`, await harness.identity(OWNER));
    expect(detail.status).toBe(200);
    expect((detail.body as GroupBody).group.id).toBe(group.id);
  });

  it('accepts PUBLIC at creation and returns it', async () => {
    const created = await harness.call('POST', '/v1/groups', await harness.identity(OWNER), {
      name: 'Open',
      visibility: 'PUBLIC',
    });
    expect(created.status).toBe(201);
    expect((created.body as GroupBody).group.visibility).toBe('PUBLIC');
  });

  it('rejects a malformed body with INVALID_REQUEST', async () => {
    const missingName = await harness.call('POST', '/v1/groups', await harness.identity(OWNER), {});
    expect(missingName.status).toBe(400);
    expect(missingName.body).toMatchObject({ error: { code: 'INVALID_REQUEST' } });

    const badCap = await harness.call('POST', '/v1/groups', await harness.identity(OWNER), {
      name: 'Bad cap',
      maxMembers: 1,
    });
    expect(badCap.status).toBe(400);

    const groupId = await seededGroup();
    const emptyPatch = await harness.call('PATCH', `/v1/groups/${groupId}`, await harness.identity(OWNER), {});
    expect(emptyPatch.status).toBe(400);
  });

  it('hides a group from non-members with 404 GROUP_NOT_FOUND', async () => {
    const groupId = await seededGroup();

    const detail = await harness.call('GET', `/v1/groups/${groupId}`, await harness.identity(OUTSIDER));
    expect(detail.status).toBe(404);
    expect(detail.body).toMatchObject({ error: { code: 'GROUP_NOT_FOUND' } });

    const remove = await harness.call('DELETE', `/v1/groups/${groupId}`, await harness.identity(OUTSIDER));
    expect(remove.status).toBe(403);
    expect(remove.body).toMatchObject({ error: { code: 'GROUP_ACCESS_DENIED' } });
  });

  it('lets a member view but not edit the group', async () => {
    const groupId = await seededGroup();
    const member = await harness.identity(MEMBER);

    const detail = await harness.call('GET', `/v1/groups/${groupId}`, member);
    expect(detail.status).toBe(200);

    const patch = await harness.call('PATCH', `/v1/groups/${groupId}`, member, { name: 'Renamed' });
    expect(patch.status).toBe(403);
    expect(patch.body).toMatchObject({ error: { code: 'FORBIDDEN' } });

    const invite = await harness.call('POST', `/v1/groups/${groupId}/members`, member, {
      userUuid: OUTSIDER,
    });
    expect(invite.status).toBe(403);
  });

  it('lets an admin edit the group and invite members, but not delete it', async () => {
    const groupId = await seededGroup();
    const owner = await harness.identity(OWNER);
    const admin = await harness.identity(ADMIN);

    const promoted = await harness.call('PATCH', `/v1/groups/${groupId}/members/${ADMIN}`, owner, {
      role: 'ADMIN',
    });
    expect(promoted.status).toBe(404); // not a member yet

    const added = await harness.call('POST', `/v1/groups/${groupId}/members`, owner, {
      userUuid: ADMIN,
      role: 'ADMIN',
    });
    expect(added.status).toBe(201);
    expect((added.body as MemberBody).member.role).toBe('ADMIN');

    const renamed = await harness.call('PATCH', `/v1/groups/${groupId}`, admin, {
      name: 'Renamed By Admin',
      visibility: 'PUBLIC',
    });
    expect(renamed.status).toBe(200);
    expect((renamed.body as GroupBody).group).toMatchObject({
      name: 'Renamed By Admin',
      visibility: 'PUBLIC',
    });

    const invited = await harness.call('POST', `/v1/groups/${groupId}/members`, admin, {
      userUuid: OUTSIDER,
    });
    expect(invited.status).toBe(201);

    // Admin cannot mint a peer admin.
    const peer = await harness.call('POST', `/v1/groups/${groupId}/members`, admin, {
      userUuid: '55555555-5555-4555-8555-555555555555',
      role: 'ADMIN',
    });
    expect(peer.status).toBe(403);

    // Admin cannot change roles or delete the group.
    const roleChange = await harness.call('PATCH', `/v1/groups/${groupId}/members/${MEMBER}`, admin, {
      role: 'ADMIN',
    });
    expect(roleChange.status).toBe(403);

    const deleted = await harness.call('DELETE', `/v1/groups/${groupId}`, admin);
    expect(deleted.status).toBe(403);
    expect(deleted.body).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('supports the member lifecycle: invite is idempotent, roles change, removal works', async () => {
    const groupId = await seededGroup();
    const owner = await harness.identity(OWNER);

    const again = await harness.call('POST', `/v1/groups/${groupId}/members`, owner, {
      userUuid: MEMBER,
    });
    expect(again.status).toBe(201);
    expect((again.body as MemberBody).member.role).toBe('MEMBER');

    const promoted = await harness.call('PATCH', `/v1/groups/${groupId}/members/${MEMBER}`, owner, {
      role: 'ADMIN',
    });
    expect(promoted.status).toBe(200);
    expect((promoted.body as MemberBody).member.role).toBe('ADMIN');

    const ownerRole = await harness.call('PATCH', `/v1/groups/${groupId}/members/${MEMBER}`, owner, {
      role: 'OWNER',
    });
    expect(ownerRole.status).toBe(400);
    expect(ownerRole.body).toMatchObject({ error: { code: 'INVALID_REQUEST' } });

    const left = await harness.call('DELETE', `/v1/groups/${groupId}/members/${MEMBER}`, await harness.identity(MEMBER));
    expect(left.status).toBe(204);
    expect(left.body).toBeNull();

    const gone = await harness.call('GET', `/v1/groups/${groupId}`, await harness.identity(MEMBER));
    expect(gone.status).toBe(404);
  });

  it('deletes the group for the owner and hides it afterwards', async () => {
    const groupId = await seededGroup();

    const deleted = await harness.call('DELETE', `/v1/groups/${groupId}`, await harness.identity(OWNER));
    expect(deleted.status).toBe(204);

    const detail = await harness.call('GET', `/v1/groups/${groupId}`, await harness.identity(OWNER));
    expect(detail.status).toBe(404);
  });

  it('records audit events with identifiers, never payloads', async () => {
    const groupId = await seededGroup();
    await harness.call('DELETE', `/v1/groups/${groupId}`, await harness.identity(OWNER));

    const entries = await IrcAuditLogModel.find({ targetType: 'group' }).lean().exec();
    const events = entries.map((entry) => entry.event);
    expect(events).toEqual(
      expect.arrayContaining(['group.created', 'group.member.joined', 'group.deleted']),
    );

    for (const entry of entries) {
      expect(entry.actorUuid).toBe(OWNER);
      // Metadata carries identifiers only; the sanitiser dropped nothing important
      // and can never contain a chat payload.
      const serialized = JSON.stringify(entry.metadata ?? {});
      expect(serialized).not.toMatch(/Night Owls|hello|text/i);
    }
  });
});
