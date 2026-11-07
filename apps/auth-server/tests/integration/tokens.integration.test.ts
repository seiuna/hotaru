import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenResponse } from '@hotaru/api-contract';
import {
  AuditLogModel,
  RefreshTokenModel,
  SessionModel,
  UserModel,
} from '../../src/infrastructure/mongo/models/index.js';
import { hashRefreshToken } from '../../src/modules/tokens/refresh-token.js';
import { revocationKey } from '../../src/plugins/auth.js';
import {
  PLAYER_NAME,
  createVerifyBody,
  postLogout,
  postRefresh,
  postVerify,
  purgeAuthCoreData,
  sessionIdOfRefreshToken,
  startHarness,
  stopHarness,
  stubMojangJoined,
  type AuthCoreHarness,
} from './support/auth-core-harness.js';

let harness: AuthCoreHarness;

beforeAll(async () => {
  harness = await startHarness();
});

beforeEach(async () => {
  await purgeAuthCoreData(harness.redis);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await stopHarness(harness);
});

interface Login {
  tokens: TokenResponse;
  sessionId: string;
  userId: string;
}

/** Runs the real handshake so every token test starts from a genuine session. */
async function login(username: string = PLAYER_NAME): Promise<Login> {
  stubMojangJoined();
  const { body } = await createVerifyBody(harness.app, username);
  const response = await postVerify(harness.app, body);
  expect(response.statusCode).toBe(200);
  const tokens = response.json<TokenResponse>();

  const sessionId = await sessionIdOfRefreshToken(tokens.refreshToken);
  const refreshDoc = await RefreshTokenModel.findOne({
    tokenHash: hashRefreshToken(tokens.refreshToken),
  }).lean();

  return { tokens, sessionId, userId: String(refreshDoc?.userId) };
}

describe('POST /api/v1/auth/refresh', () => {
  it('rotates the refresh token inside the same session', async () => {
    const { tokens, sessionId } = await login();

    const response = await postRefresh(harness.app, tokens.refreshToken);
    expect(response.statusCode).toBe(200);
    const rotated = response.json<TokenResponse>();

    expect(rotated.refreshToken).not.toBe(tokens.refreshToken);
    expect(rotated.accessToken).not.toBe(tokens.accessToken);
    expect(rotated.tokenType).toBe('Bearer');
    expect(rotated.expiresIn).toBe(harness.config.accessTokenTtlSeconds);
    expect(rotated.profile).toEqual(tokens.profile);

    const oldToken = await RefreshTokenModel.findOne({
      tokenHash: hashRefreshToken(tokens.refreshToken),
    }).lean();
    const newToken = await RefreshTokenModel.findOne({
      tokenHash: hashRefreshToken(rotated.refreshToken),
    }).lean();

    expect(oldToken?.usedAt).toBeInstanceOf(Date);
    expect(oldToken?.replacedByHash).toBe(hashRefreshToken(rotated.refreshToken));
    expect(String(newToken?.sessionId)).toBe(sessionId);
    expect(newToken?.usedAt ?? null).toBeNull();

    // Rotation never extends the session lifetime.
    const session = await SessionModel.findById(sessionId).lean();
    expect(newToken?.expiresAt.getTime()).toBe(session?.expiresAt.getTime());

    expect(await SessionModel.countDocuments({})).toBe(1);
    const events = (await AuditLogModel.find({}).lean()).map((entry) => entry.event);
    expect(events).toContain('auth.session.refreshed');
  });

  it('revokes the whole session when a rotated token is replayed (reuse detection)', async () => {
    const { tokens, sessionId, userId } = await login();
    const rotation = await postRefresh(harness.app, tokens.refreshToken);
    expect(rotation.statusCode).toBe(200);
    const rotated = rotation.json<TokenResponse>();

    // Replay the already-used token.
    const replay = await postRefresh(harness.app, tokens.refreshToken);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('REFRESH_REUSED');

    const session = await SessionModel.findById(sessionId).lean();
    expect(session?.revokedAt).toBeInstanceOf(Date);
    expect(session?.revokedReason).toBe('refresh_token_reuse');

    const tokensInSession = await RefreshTokenModel.find({
      sessionId: new Types.ObjectId(sessionId),
    }).lean();
    expect(tokensInSession.length).toBeGreaterThan(0);
    expect(tokensInSession.every((token) => token.revokedAt instanceof Date)).toBe(true);

    // Redis fast path is written so the guard rejects before touching Mongo.
    expect(await harness.redis.exists(revocationKey(sessionId))).toBe(1);

    // The legitimate successor token is dead too: the session is gone.
    const successor = await postRefresh(harness.app, rotated.refreshToken);
    expect(successor.statusCode).toBe(401);

    const reuseAudit = await AuditLogModel.findOne({ event: 'auth.refresh.reused' }).lean();
    expect(reuseAudit).not.toBeNull();
    expect(String(reuseAudit?.targetId)).toBe(sessionId);
    expect(String(reuseAudit?.actorId)).toBe(userId);
  });

  it('rejects unknown refresh tokens', async () => {
    await login();
    const response = await postRefresh(harness.app, 'A'.repeat(43));

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects an expired refresh token without revoking the session', async () => {
    const { tokens, sessionId } = await login();

    await RefreshTokenModel.updateOne(
      { tokenHash: hashRefreshToken(tokens.refreshToken) },
      { $set: { expiresAt: new Date(Date.now() - 1_000) } },
    );

    const response = await postRefresh(harness.app, tokens.refreshToken);
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');

    const session = await SessionModel.findById(sessionId).lean();
    expect(session?.revokedAt ?? null).toBeNull();
  });

  it('rejects a revoked session', async () => {
    const { tokens, sessionId } = await login();
    await SessionModel.updateOne(
      { _id: new Types.ObjectId(sessionId) },
      { $set: { revokedAt: new Date(), revokedReason: 'test' } },
    );

    const response = await postRefresh(harness.app, tokens.refreshToken);
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('SESSION_REVOKED');
  });

  it('rejects a banned user and revokes the session', async () => {
    const { tokens, sessionId } = await login();
    await UserModel.updateOne({}, { $set: { status: 'banned', banReason: 'test' } });

    const response = await postRefresh(harness.app, tokens.refreshToken);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('USER_BANNED');

    const session = await SessionModel.findById(sessionId).lean();
    expect(session?.revokedAt).toBeInstanceOf(Date);
  });

  it('requires a token in the body', async () => {
    const response = await postRefresh(harness.app, '');
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('requires a bearer access token', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
  });

  it('is idempotent for the session but rejects the second call', async () => {
    const { tokens, sessionId } = await login();

    const first = await postLogout(harness.app, tokens.accessToken);
    expect(first.statusCode).toBe(204);

    const second = await postLogout(harness.app, tokens.accessToken);
    expect(second.statusCode).toBe(401);
    expect(second.json().error.code).toBe('SESSION_REVOKED');

    // No duplicate revocation audit entries: the second call never reached the handler.
    const revocations = await AuditLogModel.countDocuments({ event: 'auth.session.revoked' });
    expect(revocations).toBe(1);
    expect(await harness.redis.exists(revocationKey(sessionId))).toBe(1);
  });

  it('leaves other sessions of the same user untouched', async () => {
    const first = await login();
    const second = await login();

    expect(first.sessionId).not.toBe(second.sessionId);

    const logout = await postLogout(harness.app, first.tokens.accessToken);
    expect(logout.statusCode).toBe(204);

    const otherRefresh = await postRefresh(harness.app, second.tokens.refreshToken);
    expect(otherRefresh.statusCode).toBe(200);
  });
});
