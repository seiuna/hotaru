import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../../context.js';
import type { AdminDeps, RevocationStore } from './service.js';

/**
 * Unit tests for the admin write paths. The Mongoose models are replaced by
 * chainable fakes and Redis by a one-method store, so the assertions are about
 * the exact commands the service issues: which sessions get revoked, which
 * Redis keys are written, and what the audit trail records.
 */
const mocks = vi.hoisted(() => ({
  userFindById: vi.fn(),
  userFindByIdAndUpdate: vi.fn(),
  userFind: vi.fn(),
  userCountDocuments: vi.fn(),
  permissionFind: vi.fn(),
  permissionBulkWrite: vi.fn(),
  sessionFind: vi.fn(),
  sessionFindById: vi.fn(),
  sessionUpdateMany: vi.fn(),
  sessionUpdateOne: vi.fn(),
  refreshTokenUpdateMany: vi.fn(),
  auditLogCreate: vi.fn(),
}));

vi.mock('../../infrastructure/mongo/models/index.js', () => ({
  UserModel: {
    findById: mocks.userFindById,
    findByIdAndUpdate: mocks.userFindByIdAndUpdate,
    find: mocks.userFind,
    countDocuments: mocks.userCountDocuments,
  },
  PermissionModel: { find: mocks.permissionFind, bulkWrite: mocks.permissionBulkWrite },
  SessionModel: {
    find: mocks.sessionFind,
    findById: mocks.sessionFindById,
    updateMany: mocks.sessionUpdateMany,
    updateOne: mocks.sessionUpdateOne,
  },
  RefreshTokenModel: { updateMany: mocks.refreshTokenUpdateMany },
  AuditLogModel: { create: mocks.auditLogCreate },
}));

import {
  banUser,
  listUsers,
  normalizeGrants,
  replacePermissions,
  revokeSession,
  unbanUser,
} from './service.js';

const USER_ID = '507f1f77bcf86cd799439011';
const ACTOR = { userId: '507f1f77bcf86cd799439012', ip: '203.0.113.9' };

let setSpy: ReturnType<typeof vi.fn>;
let deps: AdminDeps;

function lean<T>(value: T): { lean: () => Promise<T> } {
  return { lean: () => Promise.resolve(value) };
}

/** First argument of the n-th call of a spy, typed by the caller. */
function callArg<T>(spy: { mock: { calls: unknown[][] } }, index = 0): T {
  return (spy.mock.calls[index] ?? [])[0] as T;
}

function callArgs<T extends unknown[]>(spy: { mock: { calls: unknown[][] } }, index = 0): T {
  return (spy.mock.calls[index] ?? []) as unknown as T;
}

function userDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: USER_ID,
    minecraftUuid: '11111111-2222-3333-4444-555555555555',
    username: 'Notch',
    status: 'active',
    banReason: null,
    bannedAt: null,
    lastLoginAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

async function expectAppError(operation: () => Promise<unknown>, code: string): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code });
}

beforeEach(() => {
  vi.clearAllMocks();
  setSpy = vi.fn(async () => 'OK');
  const store: RevocationStore = { set: setSpy };
  const ctx = { config: { accessTokenTtlSeconds: 900 } } as unknown as AppContext;
  deps = { ctx, store };

  mocks.userFindById.mockImplementation(() => lean(userDoc()));
  mocks.userFindByIdAndUpdate.mockImplementation(() => lean(userDoc({ status: 'banned' })));
  mocks.userFind.mockImplementation(() => ({
    sort: () => ({ skip: () => ({ limit: () => lean([]) }) }),
  }));
  mocks.userCountDocuments.mockResolvedValue(0);
  mocks.permissionFind.mockImplementation(() => ({
    lean: () => Promise.resolve([]),
    sort: () => lean([]),
  }));
  mocks.permissionBulkWrite.mockResolvedValue({});
  mocks.sessionFind.mockImplementation(() => lean([]));
  mocks.sessionFindById.mockImplementation(() => lean(null));
  mocks.sessionUpdateMany.mockResolvedValue({ modifiedCount: 0 });
  mocks.sessionUpdateOne.mockResolvedValue({ modifiedCount: 0 });
  mocks.refreshTokenUpdateMany.mockResolvedValue({ modifiedCount: 0 });
  mocks.auditLogCreate.mockResolvedValue({});
});

describe('normalizeGrants', () => {
  it('keeps permanent grants and parses future expiries', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const grants = normalizeGrants(
      [
        { scope: 'hotaru:profile' },
        { scope: 'admin:users', expiresAt: '2026-06-01T00:00:00.000Z' },
      ],
      now,
    );

    expect(grants).toEqual([
      { scope: 'admin:users', expiresAt: new Date('2026-06-01T00:00:00.000Z') },
      { scope: 'hotaru:profile', expiresAt: null },
    ]);
  });

  it('treats an explicit null expiry as permanent', () => {
    const grants = normalizeGrants([{ scope: 'hotaru:license', expiresAt: null }]);
    expect(grants).toEqual([{ scope: 'hotaru:license', expiresAt: null }]);
  });

  it('rejects an expiry in the past', async () => {
    await expect(
      (async () => normalizeGrants([{ scope: 'admin:users', expiresAt: '2020-01-01T00:00:00.000Z' }]))(),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('rejects duplicate scopes instead of guessing which one wins', async () => {
    await expect(
      (async () =>
        normalizeGrants([{ scope: 'admin:users' }, { scope: 'admin:users', expiresAt: null }]))(),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST', message: expect.stringContaining('Duplicate scopes') });
  });
});

describe('replacePermissions', () => {
  const profileGrant = {
    scope: 'hotaru:profile',
    expiresAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  it('deletes grants that are absent from the request and upserts the rest in one bulk write', async () => {
    mocks.permissionFind.mockImplementation(() => ({
      lean: () =>
        Promise.resolve([
          profileGrant,
          {
            scope: 'hotaru:license',
            expiresAt: null,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
          },
        ]),
      sort: () => lean([profileGrant]),
    }));

    const result = await replacePermissions(deps, ACTOR, USER_ID, [{ scope: 'hotaru:profile' }]);

    expect(mocks.permissionBulkWrite).toHaveBeenCalledTimes(1);
    const operations = callArg<Record<string, unknown>[]>(mocks.permissionBulkWrite);
    expect(operations).toHaveLength(2);

    const deletion = operations[0]?.deleteMany as { filter: { scope: { $in: string[] } } };
    expect(deletion.filter.scope.$in).toEqual(['hotaru:license']);

    const update = operations[1]?.updateOne as {
      filter: { scope: string };
      update: { $set: { expiresAt: null; grantedBy: string } };
      upsert: boolean;
    };
    expect(update.filter.scope).toBe('hotaru:profile');
    expect(update.update.$set).toEqual({ expiresAt: null, grantedBy: ACTOR.userId });
    expect(update.upsert).toBe(true);

    expect(result.scopes).toEqual(['hotaru:profile']);

    const audit = callArg<{
      event: string;
      actorId: string;
      actorType: string;
      targetId: string;
      metadata: { added: string[]; removed: string[] };
    }>(mocks.auditLogCreate);
    expect(audit.event).toBe('user.permissions.updated');
    expect(audit.actorType).toBe('admin');
    expect(audit.actorId).toBe(ACTOR.userId);
    expect(audit.targetId).toBe(USER_ID);
    expect(audit.metadata.removed).toEqual(['hotaru:license']);
    expect(audit.metadata.added).toEqual([]);
  });

  it('reports newly added grants in the audit metadata', async () => {
    mocks.permissionFind.mockImplementation(() => ({
      lean: () => Promise.resolve([]),
      sort: () =>
        lean([
          {
            scope: 'admin:users',
            expiresAt: null,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            grantedBy: ACTOR.userId,
          },
        ]),
    }));

    const result = await replacePermissions(deps, ACTOR, USER_ID, [{ scope: 'admin:users' }]);

    const audit = callArg<{ metadata: { added: string[] } }>(mocks.auditLogCreate);
    expect(audit.metadata.added).toEqual(['admin:users']);
    expect(result.permissions).toHaveLength(1);
    expect(result.scopes).toEqual(['admin:users']);
  });

  it('404s an unknown user and writes nothing', async () => {
    mocks.userFindById.mockImplementation(() => lean(null));

    await expectAppError(() => replacePermissions(deps, ACTOR, USER_ID, []), 'NOT_FOUND');
    expect(mocks.permissionBulkWrite).not.toHaveBeenCalled();
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });

  it('rejects an expiry in the past before touching the database', async () => {
    await expectAppError(
      () =>
        replacePermissions(deps, ACTOR, USER_ID, [
          { scope: 'admin:users', expiresAt: '2020-01-01T00:00:00.000Z' },
        ]),
      'INVALID_REQUEST',
    );
    expect(mocks.permissionBulkWrite).not.toHaveBeenCalled();
  });
});

describe('banUser', () => {
  it('revokes every active session, writes the Redis fast-path key and audits the ban', async () => {
    mocks.sessionFind.mockImplementation(() =>
      lean([{ _id: '507f1f77bcf86cd799439021' }, { _id: '507f1f77bcf86cd799439022' }]),
    );
    mocks.userFindByIdAndUpdate.mockImplementation(() =>
      lean(
        userDoc({
          status: 'banned',
          banReason: 'cheating',
          bannedAt: new Date('2026-02-01T00:00:00.000Z'),
        }),
      ),
    );

    const result = await banUser(deps, ACTOR, USER_ID, 'cheating');

    expect(mocks.userFindByIdAndUpdate).toHaveBeenCalledWith(
      USER_ID,
      { $set: { status: 'banned', banReason: 'cheating', bannedAt: expect.any(Date) } },
      { new: true },
    );

    const sessionFilter = callArg<{
      userId: string;
      revokedAt: null;
      expiresAt: { $gt: Date };
    }>(mocks.sessionFind);
    expect(sessionFilter.userId).toBe(USER_ID);
    expect(sessionFilter.revokedAt).toBeNull();
    expect(sessionFilter.expiresAt.$gt).toBeInstanceOf(Date);

    expect(mocks.sessionUpdateMany).toHaveBeenCalledTimes(1);
    const [sessionUpdateFilter, sessionUpdate] = callArgs<
      [{ _id: { $in: string[] } }, { $set: { revokedAt: Date; revokedReason: string } }]
    >(mocks.sessionUpdateMany);
    expect(sessionUpdateFilter._id.$in).toEqual([
      '507f1f77bcf86cd799439021',
      '507f1f77bcf86cd799439022',
    ]);
    expect(sessionUpdate.$set.revokedReason).toBe('user_banned');
    expect(sessionUpdate.$set.revokedAt).toBeInstanceOf(Date);

    // Refresh tokens of the killed sessions must not be able to mint new tokens.
    expect(mocks.refreshTokenUpdateMany).toHaveBeenCalledWith(
      {
        sessionId: { $in: ['507f1f77bcf86cd799439021', '507f1f77bcf86cd799439022'] },
        revokedAt: null,
      },
      { $set: { revokedAt: expect.any(Date) } },
    );

    expect(setSpy).toHaveBeenCalledTimes(2);
    expect(setSpy).toHaveBeenCalledWith(
      'auth:session:revoked:507f1f77bcf86cd799439021',
      '1',
      'EX',
      900,
    );
    expect(setSpy).toHaveBeenCalledWith(
      'auth:session:revoked:507f1f77bcf86cd799439022',
      '1',
      'EX',
      900,
    );

    expect(result.sessionsRevoked).toBe(2);
    expect(result.user.status).toBe('banned');

    const audit = callArg<{
      event: string;
      actorType: string;
      targetId: string;
      metadata: { sessionsRevoked: number; reason: string };
    }>(mocks.auditLogCreate);
    expect(audit.event).toBe('user.banned');
    expect(audit.actorType).toBe('admin');
    expect(audit.targetId).toBe(USER_ID);
    expect(audit.metadata.sessionsRevoked).toBe(2);
    expect(audit.metadata.reason).toBe('cheating');
  });

  it('writes no Redis keys when the user has no active session', async () => {
    const result = await banUser(deps, ACTOR, USER_ID, null);

    expect(setSpy).not.toHaveBeenCalled();
    expect(mocks.sessionUpdateMany).not.toHaveBeenCalled();
    expect(result.sessionsRevoked).toBe(0);
  });

  it('keeps the original bannedAt when the user is already banned', async () => {
    const originalBan = new Date('2026-01-15T12:00:00.000Z');
    mocks.userFindById.mockImplementation(() =>
      lean(userDoc({ status: 'banned', banReason: 'old', bannedAt: originalBan })),
    );
    mocks.userFindByIdAndUpdate.mockImplementation(() =>
      lean(userDoc({ status: 'banned', banReason: 'old', bannedAt: originalBan })),
    );

    await banUser(deps, ACTOR, USER_ID, null);

    const update = callArgs<
      [string, { $set: { bannedAt: Date } }, { new: true }]
    >(mocks.userFindByIdAndUpdate)[1];
    expect(update.$set.bannedAt).toEqual(originalBan);
  });

  it('404s an unknown user without revoking anything', async () => {
    mocks.userFindById.mockImplementation(() => lean(null));

    await expectAppError(() => banUser(deps, ACTOR, USER_ID, 'nope'), 'NOT_FOUND');
    expect(setSpy).not.toHaveBeenCalled();
    expect(mocks.sessionUpdateMany).not.toHaveBeenCalled();
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });

  it('still returns success when the Redis fast-path write fails (MongoDB already revoked)', async () => {
    mocks.sessionFind.mockImplementation(() => lean([{ _id: '507f1f77bcf86cd799439021' }]));
    setSpy.mockRejectedValue(new Error('redis down'));

    const result = await banUser(deps, ACTOR, USER_ID, 'x');

    expect(result.sessionsRevoked).toBe(1);
    expect(mocks.sessionUpdateMany).toHaveBeenCalledTimes(1);
    const audit = callArg<{ metadata: { revocationKeyFailures: number } }>(mocks.auditLogCreate);
    expect(audit.metadata.revocationKeyFailures).toBe(1);
  });
});

describe('unbanUser', () => {
  it('clears the ban fields and audits the unban', async () => {
    mocks.userFindById.mockImplementation(() =>
      lean(userDoc({ status: 'banned', banReason: 'x', bannedAt: new Date() })),
    );
    mocks.userFindByIdAndUpdate.mockImplementation(() => lean(userDoc({ status: 'active' })));

    const result = await unbanUser(deps, ACTOR, USER_ID);

    expect(mocks.userFindByIdAndUpdate).toHaveBeenCalledWith(
      USER_ID,
      { $set: { status: 'active', banReason: null, bannedAt: null } },
      { new: true },
    );
    expect(result.user.status).toBe('active');
    const audit = callArg<{ event: string; metadata: { wasBanned: boolean } }>(
      mocks.auditLogCreate,
    );
    expect(audit.event).toBe('user.unbanned');
    expect(audit.metadata.wasBanned).toBe(true);
  });
});

describe('revokeSession', () => {
  it('revokes the session and writes the Redis revocation key', async () => {
    mocks.sessionFindById.mockImplementation(() =>
      lean({
        _id: '507f1f77bcf86cd799439031',
        userId: USER_ID,
        expiresAt: new Date('2026-12-01T00:00:00.000Z'),
        revokedAt: null,
        ip: null,
        userAgent: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
    );

    const result = await revokeSession(deps, ACTOR, '507f1f77bcf86cd799439031', 'lost laptop');

    expect(mocks.sessionUpdateOne).toHaveBeenCalledWith(
      { _id: '507f1f77bcf86cd799439031' },
      { $set: { revokedAt: expect.any(Date), revokedReason: 'lost laptop' } },
    );
    expect(setSpy).toHaveBeenCalledWith(
      'auth:session:revoked:507f1f77bcf86cd799439031',
      '1',
      'EX',
      900,
    );
    expect(result.session.revokedAt).not.toBeNull();
    const audit = callArg<{ event: string; targetType: string }>(mocks.auditLogCreate);
    expect(audit.event).toBe('auth.session.revoked');
    expect(audit.targetType).toBe('session');
  });

  it('is idempotent for an already revoked session', async () => {
    mocks.sessionFindById.mockImplementation(() =>
      lean({
        _id: '507f1f77bcf86cd799439032',
        userId: USER_ID,
        expiresAt: new Date('2026-12-01T00:00:00.000Z'),
        revokedAt: new Date('2026-02-01T00:00:00.000Z'),
        ip: null,
        userAgent: null,
      }),
    );

    await revokeSession(deps, ACTOR, '507f1f77bcf86cd799439032', null);

    expect(mocks.sessionUpdateOne).not.toHaveBeenCalled();
    expect(setSpy).toHaveBeenCalledTimes(1);
  });

  it('404s an unknown session', async () => {
    await expectAppError(
      () => revokeSession(deps, ACTOR, '507f1f77bcf86cd799439033', null),
      'NOT_FOUND',
    );
    expect(setSpy).not.toHaveBeenCalled();
  });
});

describe('listUsers', () => {
  it('escapes the search term and matches username substrings or UUID prefixes', async () => {
    await listUsers({ query: 'a.*b(', limit: 20, offset: 0 });

    const filter = callArg<{
      $or: [{ username: { $regex: string } }, { minecraftUuid: { $regex: string } }];
    }>(mocks.userFind);
    expect(filter.$or[0].username.$regex).toBe('a\\.\\*b\\(');
    expect(filter.$or[1].minecraftUuid.$regex).toBe('^a\\.\\*b\\(');
  });

  it('filters by status and returns the pagination echo', async () => {
    mocks.userCountDocuments.mockResolvedValue(3);

    const result = await listUsers({ status: 'banned', limit: 10, offset: 20 });

    expect(callArg(mocks.userFind)).toEqual({ status: 'banned' });
    expect(result).toEqual({ users: [], total: 3, limit: 10, offset: 20 });
  });
});
