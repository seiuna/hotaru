import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import {
  MinecraftLinkModel,
  PermissionModel,
  SessionModel,
  UserModel,
} from '../../src/infrastructure/mongo/models/index.js';
import { revocationKey } from '../../src/plugins/auth.js';
import {
  bearer,
  SESSION_TTL_MS,
  startHarness,
  stopHarness,
  TestData,
  type Harness,
} from './support/users-admin-harness.js';

interface ErrorBody {
  error: { code: string; message: string };
}

interface UserViewBody {
  user: {
    id: string;
    minecraftUuid: string;
    username: string;
    status: 'active' | 'banned';
    createdAt: string;
    lastLoginAt: string | null;
  };
}

/**
 * Admin API against the real app (`app.inject`) plus real MongoDB/Redis.
 * The security properties under test: admin scope enforcement, live ban/revoke
 * behaviour for already-issued JWTs, and the revocation side effects.
 */
describe('admin API', () => {
  let harness: Harness;
  let data: TestData;

  beforeAll(async () => {
    harness = await startHarness();
    data = new TestData(harness.ctx);
  });

  afterEach(async () => {
    await data.cleanup();
  });

  afterAll(async () => {
    await stopHarness(harness);
  });

  async function createAdmin(): Promise<{ id: string; accessToken: string }> {
    const admin = await data.createUser({ scopes: [{ scope: 'admin:users' }] });
    return { id: admin.id, accessToken: admin.accessToken };
  }

  it('returns 401 for /admin/users without a token', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/v1/admin/users' });

    expect(response.statusCode).toBe(401);
    expect((response.json() as ErrorBody).error.code).toBe('UNAUTHORIZED');
  });

  it('returns 403 for an authenticated user without admin:users', async () => {
    const user = await data.createUser({ scopes: [{ scope: 'hotaru:profile' }] });
    // Even a token that claims the scope is not enough: authority is the database.
    const token = await data.mintAccessToken({
      userId: user.id,
      minecraftUuid: user.minecraftUuid,
      sessionId: user.sessionId,
      scopes: ['admin:users'],
    });

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(403);
    expect((response.json() as ErrorBody).error.code).toBe('FORBIDDEN');
  });

  it('searches users by username substring and by UUID prefix, with pagination totals', async () => {
    const admin = await createAdmin();
    const needle = data.newUsername('Adm');
    const first = await data.createUser({ username: needle });
    const second = await data.createUser();
    await data.createUser({ username: data.newUsername('Other'), status: 'banned' });

    const byName = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/admin/users?query=${encodeURIComponent(needle.slice(0, 6))}&limit=10&offset=0`,
      headers: bearer(admin.accessToken),
    });
    expect(byName.statusCode).toBe(200);
    const nameBody = byName.json() as { users: Array<{ id: string }>; total: number; limit: number; offset: number };
    expect(nameBody.limit).toBe(10);
    expect(nameBody.offset).toBe(0);
    expect(nameBody.users.map((user) => user.id)).toContain(first.id);
    expect(nameBody.users.map((user) => user.id)).not.toContain(second.id);
    expect(nameBody.total).toBeGreaterThanOrEqual(1);

    const byUuid = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/admin/users?query=${encodeURIComponent(first.minecraftUuid.slice(0, 8))}`,
      headers: bearer(admin.accessToken),
    });
    expect(byUuid.statusCode).toBe(200);
    expect((byUuid.json() as { users: Array<{ id: string }> }).users.map((user) => user.id)).toContain(
      first.id,
    );

    const bannedOnly = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/admin/users?status=banned&limit=100',
      headers: bearer(admin.accessToken),
    });
    const bannedBody = bannedOnly.json() as { users: Array<{ status: string }> };
    expect(bannedBody.users.every((user) => user.status === 'banned')).toBe(true);
  });

  it('grants a permission that applies immediately to an already-issued JWT, and removes it just as fast', async () => {
    const admin = await createAdmin();
    const target = await data.createUser({ scopes: [{ scope: 'hotaru:profile' }] });

    const before = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: bearer(target.accessToken),
    });
    expect(before.statusCode).toBe(403);

    const granted = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/admin/users/${target.id}/permissions`,
      headers: bearer(admin.accessToken),
      payload: {
        permissions: [
          { scope: 'hotaru:profile' },
          { scope: 'admin:users', expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
        ],
      },
    });
    expect(granted.statusCode).toBe(200);
    const grantedBody = granted.json() as {
      permissions: Array<{ scope: string; grantedAt: string; expiresAt: string | null; grantedBy: string | null }>;
      scopes: string[];
    };
    expect(grantedBody.scopes.sort()).toEqual(['admin:users', 'hotaru:profile']);
    const adminGrant = grantedBody.permissions.find((permission) => permission.scope === 'admin:users');
    expect(adminGrant?.grantedBy).toBe(admin.id);
    expect(adminGrant?.expiresAt).not.toBeNull();
    expect(new Date(adminGrant?.grantedAt ?? '').toString()).not.toBe('Invalid Date');

    // Same JWT as before the grant — the guard re-reads MongoDB.
    const after = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: bearer(target.accessToken),
    });
    expect(after.statusCode).toBe(200);

    const reflected = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/users/me/permissions',
      headers: bearer(target.accessToken),
    });
    expect((reflected.json() as { scopes: string[] }).scopes.sort()).toEqual([
      'admin:users',
      'hotaru:profile',
    ]);

    // Replace the set with only the profile scope => admin access is gone.
    const removed = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/admin/users/${target.id}/permissions`,
      headers: bearer(admin.accessToken),
      payload: { permissions: [{ scope: 'hotaru:profile' }] },
    });
    expect(removed.statusCode).toBe(200);
    expect((removed.json() as { scopes: string[] }).scopes).toEqual(['hotaru:profile']);

    const deniedAgain = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: bearer(target.accessToken),
    });
    expect(deniedAgain.statusCode).toBe(403);

    const remaining = await PermissionModel.find({ userId: target.id }).lean();
    expect(remaining.map((permission) => permission.scope)).toEqual(['hotaru:profile']);
  });

  it('rejects invalid permission payloads', async () => {
    const admin = await createAdmin();
    const target = await data.createUser();

    const pastExpiry = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/admin/users/${target.id}/permissions`,
      headers: bearer(admin.accessToken),
      payload: { permissions: [{ scope: 'admin:users', expiresAt: '2020-01-01T00:00:00.000Z' }] },
    });
    expect(pastExpiry.statusCode).toBe(400);
    expect((pastExpiry.json() as ErrorBody).error.code).toBe('INVALID_REQUEST');

    const unknownScope = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/admin/users/${target.id}/permissions`,
      headers: bearer(admin.accessToken),
      payload: { permissions: [{ scope: 'admin:everything' }] },
    });
    expect(unknownScope.statusCode).toBe(400);

    const duplicate = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/admin/users/${target.id}/permissions`,
      headers: bearer(admin.accessToken),
      payload: { permissions: [{ scope: 'admin:users' }, { scope: 'admin:users' }] },
    });
    expect(duplicate.statusCode).toBe(400);
  });

  it('404s unknown users, malformed ids and unknown sessions', async () => {
    const admin = await createAdmin();
    const missingId = new Types.ObjectId().toHexString();

    const unknownUser = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/admin/users/${missingId}/permissions`,
      headers: bearer(admin.accessToken),
      payload: { permissions: [] },
    });
    expect(unknownUser.statusCode).toBe(404);
    expect((unknownUser.json() as ErrorBody).error.code).toBe('NOT_FOUND');

    const malformed = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/admin/users/not-an-id/ban',
      headers: bearer(admin.accessToken),
      payload: {},
    });
    expect(malformed.statusCode).toBe(404);

    const unknownSession = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/admin/sessions/${missingId}/revoke`,
      headers: bearer(admin.accessToken),
      payload: {},
    });
    expect(unknownSession.statusCode).toBe(404);

    const unknownUnban = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${missingId}/unban`,
      headers: bearer(admin.accessToken),
    });
    expect(unknownUnban.statusCode).toBe(404);
  });

  it('bans a user: revokes their sessions, writes Redis keys, and blocks the already-issued JWT', async () => {
    const admin = await createAdmin();
    const target = await data.createUser({ scopes: [{ scope: 'hotaru:profile' }] });

    const before = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: bearer(target.accessToken),
    });
    expect(before.statusCode).toBe(200);

    const banned = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${target.id}/ban`,
      headers: bearer(admin.accessToken),
      payload: { reason: 'cheating' },
    });
    expect(banned.statusCode).toBe(200);
    const bannedBody = banned.json() as UserViewBody & { sessionsRevoked: number };
    expect(bannedBody.user.status).toBe('banned');
    expect(bannedBody.sessionsRevoked).toBe(1);

    const stored = await UserModel.findById(target.id).lean();
    expect(stored?.status).toBe('banned');
    expect(stored?.banReason).toBe('cheating');
    expect(stored?.bannedAt).toBeInstanceOf(Date);

    const session = await SessionModel.findById(target.sessionId).lean();
    expect(session?.revokedAt).toBeInstanceOf(Date);
    expect(session?.revokedReason).toBe('user_banned');

    // The revocation fast-path key is written with the access-token TTL cap.
    const key = revocationKey(target.sessionId);
    expect(await harness.ctx.redis.get(key)).toBe('1');
    const ttl = await harness.ctx.redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(harness.ctx.config.accessTokenTtlSeconds);

    // The very same JWT is now rejected with USER_BANNED (the ban is checked
    // after the session revocation in the guard, but both fail closed).
    const after = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: bearer(target.accessToken),
    });
    expect(after.statusCode).toBe(403);
    expect((after.json() as ErrorBody).error.code).toBe('USER_BANNED');

    const audit = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs?event=user.banned',
      headers: bearer(admin.accessToken),
    });
    expect(audit.statusCode).toBe(200);
    const auditBody = audit.json() as {
      logs: Array<{ event: string; actorId: string; targetId: string; metadata: Record<string, unknown> }>;
      total: number;
    };
    const entry = auditBody.logs.find((log) => log.targetId === target.id);
    expect(entry).toBeDefined();
    expect(entry?.actorId).toBe(admin.id);
    expect(entry?.metadata).toMatchObject({ reason: 'cheating', sessionsRevoked: 1 });
  });

  it('unbans a user but keeps the revoked sessions revoked', async () => {
    const admin = await createAdmin();
    const target = await data.createUser();

    await harness.app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${target.id}/ban`,
      headers: bearer(admin.accessToken),
      payload: {},
    });

    const unbanned = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${target.id}/unban`,
      headers: bearer(admin.accessToken),
    });
    expect(unbanned.statusCode).toBe(200);
    const body = unbanned.json() as UserViewBody;
    expect(body.user.status).toBe('active');

    const stored = await UserModel.findById(target.id).lean();
    expect(stored?.status).toBe('active');
    expect(stored?.banReason).toBeNull();
    expect(stored?.bannedAt).toBeNull();

    // The old access token stays dead: its session was revoked by the ban.
    const after = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: bearer(target.accessToken),
    });
    expect(after.statusCode).toBe(401);
    expect((after.json() as ErrorBody).error.code).toBe('SESSION_REVOKED');
  });

  it('revokes a single session and blocks the token that belongs to it', async () => {
    const admin = await createAdmin();
    const target = await data.createUser();

    const revoked = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/admin/sessions/${target.sessionId}/revoke`,
      headers: bearer(admin.accessToken),
      payload: { reason: 'lost device' },
    });
    expect(revoked.statusCode).toBe(200);
    const body = revoked.json() as { session: { id: string; revokedAt: string | null } };
    expect(body.session.id).toBe(target.sessionId);
    expect(body.session.revokedAt).not.toBeNull();

    expect(await harness.ctx.redis.get(revocationKey(target.sessionId))).toBe('1');
    const session = await SessionModel.findById(target.sessionId).lean();
    expect(session?.revokedAt).toBeInstanceOf(Date);
    expect(session?.revokedReason).toBe('lost device');

    const after = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: bearer(target.accessToken),
    });
    expect(after.statusCode).toBe(401);
    expect((after.json() as ErrorBody).error.code).toBe('SESSION_REVOKED');
  });

  it('returns audit logs newest first and filters by actor', async () => {
    const admin = await createAdmin();
    const firstTarget = await data.createUser();
    const secondTarget = await data.createUser();

    await harness.app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${firstTarget.id}/ban`,
      headers: bearer(admin.accessToken),
      payload: { reason: 'first' },
    });
    await harness.app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${secondTarget.id}/ban`,
      headers: bearer(admin.accessToken),
      payload: { reason: 'second' },
    });

    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/admin/audit-logs?actorId=${admin.id}&event=user.banned&limit=10&offset=0`,
      headers: bearer(admin.accessToken),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      logs: Array<{ event: string; targetId: string; createdAt: string; actorId: string }>;
      total: number;
    };
    expect(body.total).toBeGreaterThanOrEqual(2);
    const targets = body.logs.map((log) => log.targetId);
    expect(targets).toContain(firstTarget.id);
    expect(targets).toContain(secondTarget.id);
    // Newest first: the second ban was written last.
    expect(targets.indexOf(secondTarget.id)).toBeLessThan(targets.indexOf(firstTarget.id));
    expect(body.logs.every((log) => log.actorId === admin.id)).toBe(true);
  });

  it('bans one linked UUID without banning the account or other links', async () => {
    const admin = await createAdmin();
    const target = await data.createUser();
    const now = new Date();
    await MinecraftLinkModel.create({
      accountId: target.id,
      minecraftUuid: target.minecraftUuid,
      minecraftUsername: target.username,
      status: 'active',
      verifiedAt: now,
      linkedAt: now,
    });
    await SessionModel.updateOne(
      { _id: target.sessionId },
      { $set: { minecraftUuid: target.minecraftUuid, kind: 'mc' } },
    );

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${target.id}/links/${target.minecraftUuid}/ban`,
      headers: bearer(admin.accessToken),
      payload: { reason: 'single identity test' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      link: { uuid: string; status: string };
      sessionsRevoked: number;
    };
    expect(body.link.status).toBe('banned');
    expect(body.sessionsRevoked).toBe(1);

    const link = await MinecraftLinkModel.findOne({
      accountId: target.id,
      minecraftUuid: target.minecraftUuid,
    }).lean();
    expect(link?.status).toBe('banned');
    const session = await SessionModel.findById(target.sessionId).lean();
    expect(session?.revokedAt).not.toBeNull();
    expect(await harness.ctx.redis.get(revocationKey(target.sessionId))).toBe('1');

    const user = await UserModel.findById(target.id).lean();
    expect(user?.status).toBe('active');
  });

  it('keeps the target sessions untouched when banning an unknown user id', async () => {
    const admin = await createAdmin();
    const target = await data.createUser();
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${new Types.ObjectId().toHexString()}/ban`,
      headers: bearer(admin.accessToken),
      payload: {},
    });
    expect(response.statusCode).toBe(404);

    const session = await SessionModel.findById(target.sessionId).lean();
    expect(session?.revokedAt).toBeNull();
    expect(await harness.ctx.redis.get(revocationKey(target.sessionId))).toBeNull();
    // The target's own session TTL is a week; assert the fixture is still live.
    expect((session?.expiresAt?.getTime() ?? 0) - Date.now()).toBeLessThanOrEqual(SESSION_TTL_MS);
  });
});
