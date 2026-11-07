import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SessionModel, UserModel } from '../../src/infrastructure/mongo/models/index.js';
import { revocationKey } from '../../src/plugins/auth.js';
import {
  bearer,
  startHarness,
  stopHarness,
  TestData,
  type Harness,
} from './support/users-admin-harness.js';

/**
 * GET /api/v1/users/me and /me/permissions against the real Express-less app
 * (app.inject) with real Mongo + Redis. These tests prove that effective scopes
 * come from MongoDB — never from the token's claims — and that a ban or a
 * revocation is applied on the very next request.
 */
describe('users/me + users/me/permissions', () => {
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

  it('returns 401 for a request without a bearer token', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/v1/users/me' });

    expect(response.statusCode).toBe(401);
    const body = response.json() as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns the caller profile and ignores scopes claimed in the token', async () => {
    const user = await data.createUser();
    const claimed = await data.mintAccessToken({
      userId: user.id,
      minecraftUuid: user.minecraftUuid,
      sessionId: user.sessionId,
      // The token claims an admin scope the database does not grant.
      scopes: ['admin:users', 'hotaru:profile'],
    });

    const me = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: bearer(claimed),
    });
    expect(me.statusCode).toBe(200);
    const body = me.json() as {
      user: { id: string; username: string; minecraftUuid: string; status: string; createdAt: string };
      scopes: string[];
    };
    expect(body.user.id).toBe(user.id);
    expect(body.user.username).toBe(user.username);
    expect(body.user.minecraftUuid).toBe(user.minecraftUuid);
    expect(body.user.status).toBe('active');
    expect(new Date(body.user.createdAt).toString()).not.toBe('Invalid Date');
    // Claimed scopes are ignored; MongoDB has none.
    expect(body.scopes).toEqual([]);

    // ...and the claimed admin scope does not get admin access either.
    const admin = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: bearer(claimed),
    });
    expect(admin.statusCode).toBe(403);
  });

  it('lists grants (including expired ones) but only effective scopes', async () => {
    const user = await data.createUser({ scopes: [{ scope: 'hotaru:profile' }] });
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const future = new Date(Date.now() + 60 * 60 * 1000);
    await data.grant(user.id, 'admin:users', past);
    await data.grant(user.id, 'hotaru:license', future);

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/users/me/permissions',
      headers: bearer(user.accessToken),
    });
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      permissions: Array<{ scope: string; grantedAt: string; expiresAt: string | null; grantedBy: string | null }>;
      scopes: string[];
    };
    expect(body.permissions.map((permission) => permission.scope).sort()).toEqual([
      'admin:users',
      'hotaru:license',
      'hotaru:profile',
    ]);
    expect(body.permissions.every((permission) => permission.grantedBy === 'test')).toBe(true);
    expect(body.permissions.find((permission) => permission.scope === 'admin:users')?.expiresAt).not.toBeNull();
    expect(body.permissions.find((permission) => permission.scope === 'hotaru:profile')?.expiresAt).toBeNull();
    // Only the unexpired grants are effective.
    expect(body.scopes.sort()).toEqual(['hotaru:license', 'hotaru:profile']);
  });

  it('rejects a banned user on the next request even with a valid JWT', async () => {
    const user = await data.createUser();

    const before = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: bearer(user.accessToken),
    });
    expect(before.statusCode).toBe(200);

    await UserModel.updateOne(
      { _id: user.id },
      { $set: { status: 'banned', banReason: 'test', bannedAt: new Date() } },
    );

    const after = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: bearer(user.accessToken),
    });
    expect(after.statusCode).toBe(403);
    expect((after.json() as { error: { code: string } }).error.code).toBe('USER_BANNED');
  });

  it('rejects a session revoked in MongoDB on the next request', async () => {
    const user = await data.createUser();
    await SessionModel.updateOne(
      { _id: user.sessionId },
      { $set: { revokedAt: new Date(), revokedReason: 'test' } },
    );

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: bearer(user.accessToken),
    });
    expect(response.statusCode).toBe(401);
    expect((response.json() as { error: { code: string } }).error.code).toBe('SESSION_REVOKED');
  });

  it('rejects a session with a Redis revocation key (fast path)', async () => {
    const user = await data.createUser();
    await harness.ctx.redis.set(revocationKey(user.sessionId), '1', 'EX', 60);

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: bearer(user.accessToken),
    });
    expect(response.statusCode).toBe(401);
    expect((response.json() as { error: { code: string } }).error.code).toBe('SESSION_REVOKED');
  });

  it('rejects a token whose session belongs to another user', async () => {
    const user = await data.createUser();
    const other = await data.createUser();
    const forgedLink = await data.mintAccessToken({
      userId: user.id,
      minecraftUuid: user.minecraftUuid,
      sessionId: other.sessionId,
    });

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: bearer(forgedLink),
    });
    expect(response.statusCode).toBe(401);
  });
});
