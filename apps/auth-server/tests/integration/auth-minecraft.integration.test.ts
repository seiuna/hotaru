import { randomUUID } from 'node:crypto';
import { jwtVerify } from 'jose';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChallengeResponse, TokenResponse } from '@hotaru/api-contract';
import {
  AuditLogModel,
  PermissionModel,
  RefreshTokenModel,
  SessionModel,
  UserModel,
} from '../../src/infrastructure/mongo/models/index.js';
import { hashRefreshToken } from '../../src/modules/tokens/refresh-token.js';
import { challengeKey } from '../../src/modules/minecraft-auth/challenge-store.js';
import {
  DEFAULT_SCOPES,
  PLAYER_NAME,
  PLAYER_UUID,
  PLAYER_UUID_UNDASHED,
  createChallenge,
  createVerifyBody,
  foreignRsaPublicKeyBase64,
  postChallenge,
  postLogout,
  postRefresh,
  postVerify,
  purgeAuthCoreData,
  seedLinkedAccount,
  startHarness,
  stopHarness,
  stubMojang,
  stubMojangJoined,
  type AuthCoreHarness,
} from './support/auth-core-harness.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

describe('POST /api/v1/auth/minecraft/challenge', () => {
  it('issues a single-use challenge bound to the service RSA key', async () => {
    const response = await postChallenge(harness.app, PLAYER_NAME);

    expect(response.statusCode).toBe(200);
    const challenge = response.json<ChallengeResponse>();

    expect(challenge.challengeId).toMatch(UUID_V4);
    expect(challenge.publicKey).toBe(harness.ctx.keys.minecraft.publicKeyBase64);
    expect(challenge.expiresIn).toBe(harness.config.challengeTtlSeconds);
    expect(Buffer.from(challenge.verifyToken, 'base64').length).toBe(4);
    expect(Buffer.from(challenge.serverId, 'base64url').length).toBe(16);

    // TTL is actually applied to the Redis entry (contract key).
    const ttl = await harness.redis.ttl(challengeKey(challenge.challengeId));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(harness.config.challengeTtlSeconds);

    const stored = await harness.redis.get(challengeKey(challenge.challengeId));
    expect(stored).toContain('PENDING');
  });

  it('rejects usernames that are not valid Minecraft names', async () => {
    const response = await postChallenge(harness.app, 'not a valid name!');
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
  });
});

describe('POST /api/v1/auth/minecraft/verify', () => {
  it('completes challenge -> verify -> refresh -> logout', async () => {
    await seedLinkedAccount();
    stubMojangJoined();

    const challenge = await createChallenge(harness.app, PLAYER_NAME);
    const { body } = await createVerifyBody(harness.app, PLAYER_NAME, { challenge });

    const verifyResponse = await postVerify(harness.app, body);
    expect(verifyResponse.statusCode).toBe(200);
    const tokens = verifyResponse.json<TokenResponse>();

    expect(tokens.tokenType).toBe('Bearer');
    expect(tokens.expiresIn).toBe(harness.config.accessTokenTtlSeconds);
    expect(tokens.profile).toEqual({ uuid: PLAYER_UUID, username: PLAYER_NAME });
    expect([...tokens.scopes].sort()).toEqual([...DEFAULT_SCOPES].sort());

    // --- access token claims ------------------------------------------------
    const { payload, protectedHeader } = await jwtVerify(
      tokens.accessToken,
      harness.ctx.keys.jwt.publicKey,
      {
        issuer: harness.config.jwtIssuer,
        audience: harness.config.jwtAudience,
        algorithms: ['EdDSA'],
      },
    );
    expect(protectedHeader.alg).toBe('EdDSA');

    const user = await UserModel.findOne({ minecraftUuid: PLAYER_UUID }).lean();
    expect(user).not.toBeNull();
    expect(user?.username).toBe(PLAYER_NAME);
    expect(user?.status).toBe('active');
    expect(user?.lastLoginAt).toBeInstanceOf(Date);

    const sessions = await SessionModel.find({ userId: new Types.ObjectId(String(user?._id)) }).lean();
    expect(sessions).toHaveLength(1);
    const sessionId = String(sessions[0]?._id);

    expect(payload.iss).toBe(harness.config.jwtIssuer);
    expect(payload.sub).toBe(String(user?._id));
    expect(payload.sub).not.toBe(PLAYER_UUID);
    expect(payload.aud).toEqual([harness.config.jwtAudience]);
    expect(payload.minecraft_uuid).toBe(PLAYER_UUID);
    expect(payload.sid).toBe(sessionId);
    expect(typeof payload.jti).toBe('string');
    expect(String(payload.scope).split(' ').sort()).toEqual([...DEFAULT_SCOPES].sort());

    // --- persistence --------------------------------------------------------
    const permissions = await PermissionModel.find({
      userId: new Types.ObjectId(String(user?._id)),
    }).lean();
    expect(permissions.map((permission) => permission.scope).sort()).toEqual(
      [...DEFAULT_SCOPES].sort(),
    );

    const refreshDoc = await RefreshTokenModel.findOne({
      tokenHash: hashRefreshToken(tokens.refreshToken),
    }).lean();
    expect(refreshDoc).not.toBeNull();
    expect(refreshDoc?.usedAt ?? null).toBeNull();
    // The raw refresh token is never persisted.
    expect(JSON.stringify(refreshDoc)).not.toContain(tokens.refreshToken);

    // --- refresh rotation ---------------------------------------------------
    const refreshResponse = await postRefresh(harness.app, tokens.refreshToken);
    expect(refreshResponse.statusCode).toBe(200);
    const rotated = refreshResponse.json<TokenResponse>();

    expect(rotated.refreshToken).not.toBe(tokens.refreshToken);
    expect(rotated.accessToken).not.toBe(tokens.accessToken);
    expect(rotated.profile).toEqual(tokens.profile);

    const usedDoc = await RefreshTokenModel.findOne({
      tokenHash: hashRefreshToken(tokens.refreshToken),
    }).lean();
    expect(usedDoc?.usedAt).toBeInstanceOf(Date);
    expect(usedDoc?.replacedByHash).toBe(hashRefreshToken(rotated.refreshToken));

    const rotatedDoc = await RefreshTokenModel.findOne({
      tokenHash: hashRefreshToken(rotated.refreshToken),
    }).lean();
    expect(String(rotatedDoc?.sessionId)).toBe(sessionId);

    const rotatedClaims = await jwtVerify(rotated.accessToken, harness.ctx.keys.jwt.publicKey, {
      issuer: harness.config.jwtIssuer,
      audience: harness.config.jwtAudience,
    });
    expect(rotatedClaims.payload.sid).toBe(sessionId);

    // --- logout -------------------------------------------------------------
    const logoutResponse = await postLogout(harness.app, rotated.accessToken);
    expect(logoutResponse.statusCode).toBe(204);
    expect(logoutResponse.body).toBe('');

    const session = await SessionModel.findById(sessionId).lean();
    expect(session?.revokedAt).toBeInstanceOf(Date);
    expect(session?.revokedReason).toBe('user_logout');

    const outstanding = await RefreshTokenModel.find({
      sessionId: new Types.ObjectId(sessionId),
    }).lean();
    expect(outstanding.length).toBeGreaterThan(0);
    expect(outstanding.every((token) => token.revokedAt instanceof Date)).toBe(true);

    const revocationTtl = await harness.redis.ttl(`auth:session:revoked:${sessionId}`);
    expect(revocationTtl).toBeGreaterThan(0);
    expect(revocationTtl).toBeLessThanOrEqual(harness.config.accessTokenTtlSeconds);

    // Revoked access token is rejected on the very next request.
    const reuseAccess = await postLogout(harness.app, rotated.accessToken);
    expect(reuseAccess.statusCode).toBe(401);
    expect(reuseAccess.json().error.code).toBe('SESSION_REVOKED');

    // Revoked refresh token is rejected too.
    const reuseRefresh = await postRefresh(harness.app, rotated.refreshToken);
    expect(reuseRefresh.statusCode).toBe(401);

    // --- audit trail --------------------------------------------------------
    const events = (await AuditLogModel.find({}).lean()).map((entry) => entry.event);
    expect(events).toContain('auth.challenge.created');
    expect(events).toContain('auth.session.created');
    expect(events).toContain('auth.session.refreshed');
    expect(events).toContain('auth.session.revoked');
  });

  it('ignores client-supplied identity claims (uuid / scopes)', async () => {
    await seedLinkedAccount();
    stubMojangJoined();

    const { body } = await createVerifyBody(harness.app, PLAYER_NAME);
    const forged = {
      ...body,
      uuid: 'deadbeef-dead-beef-dead-beefdeadbeef',
      minecraftUuid: 'deadbeef-dead-beef-dead-beefdeadbeef',
      scopes: ['admin:users'],
      premium: true,
    };

    const response = await postVerify(harness.app, forged);
    expect(response.statusCode).toBe(200);
    const tokens = response.json<TokenResponse>();

    expect(tokens.profile.uuid).toBe(PLAYER_UUID);
    expect([...tokens.scopes].sort()).toEqual([...DEFAULT_SCOPES].sort());
    expect(await UserModel.countDocuments({ minecraftUuid: 'deadbeef-dead-beef-dead-beefdeadbeef' })).toBe(0);
  });

  it('rejects a replayed verify on an already consumed challenge', async () => {
    await seedLinkedAccount();
    stubMojangJoined();

    const { body } = await createVerifyBody(harness.app, PLAYER_NAME);
    const first = await postVerify(harness.app, body);
    expect(first.statusCode).toBe(200);

    const second = await postVerify(harness.app, body);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatchObject({ code: 'CHALLENGE_CONSUMED', retryable: false });

    // Only one session ever came out of it.
    expect(await SessionModel.countDocuments({})).toBe(1);
  });

  it('lets exactly one of two concurrent verifies consume the challenge', async () => {
    await seedLinkedAccount();
    stubMojangJoined();

    const { body } = await createVerifyBody(harness.app, PLAYER_NAME);

    const [a, b] = await Promise.all([
      postVerify(harness.app, body),
      postVerify(harness.app, body),
    ]);
    const statuses = [a.statusCode, b.statusCode].sort((x, y) => x - y);

    expect(statuses).toEqual([200, 409]);
    expect(await SessionModel.countDocuments({})).toBe(1);
  });

  it('reports CHALLENGE_EXPIRED once the challenge is gone from Redis', async () => {
    stubMojangJoined();

    const challenge = await createChallenge(harness.app, PLAYER_NAME);
    // Emulate the TTL firing: the payload key is gone, the terminal marker says
    // the id was issued, which is exactly what a real expiry looks like.
    await harness.redis.del(challengeKey(challenge.challengeId));

    const { body } = await createVerifyBody(harness.app, PLAYER_NAME, { challenge });
    const response = await postVerify(harness.app, body);

    expect(response.statusCode).toBe(410);
    expect(response.json().error.code).toBe('CHALLENGE_EXPIRED');
  });

  it('really expires a challenge after CHALLENGE_TTL_SECONDS', async () => {
    stubMojangJoined();

    const challenge = await createChallenge(harness.app, PLAYER_NAME);
    const waitMs = (harness.config.challengeTtlSeconds + 1) * 1000;
    await new Promise((resolve) => setTimeout(resolve, waitMs));

    const { body } = await createVerifyBody(harness.app, PLAYER_NAME, { challenge });
    const response = await postVerify(harness.app, body);

    expect(response.statusCode).toBe(410);
    expect(response.json().error.code).toBe('CHALLENGE_EXPIRED');
  }, 30_000);

  it('reports CHALLENGE_NOT_FOUND for an unknown challenge id', async () => {
    // Rate limits are configured high in the harness, so this is genuinely an
    // unknown id rather than a throttled request.
    const response = await postVerify(harness.app, {
      challengeId: randomUUID(),
      username: PLAYER_NAME,
      encryptedSharedSecret: 'AAAA',
      encryptedVerifyToken: 'AAAA',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('CHALLENGE_NOT_FOUND');
  });

  it('rejects a verify whose username differs from the challenge', async () => {
    stubMojangJoined();

    const challenge = await createChallenge(harness.app, PLAYER_NAME);
    const { body } = await createVerifyBody(harness.app, PLAYER_NAME, {
      challenge,
      verifyUsername: 'SomebodyElse',
    });

    const response = await postVerify(harness.app, body);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');

    // The challenge is burned: no second attempt, not even with the right name.
    const retry = await postVerify(harness.app, {
      ...body,
      username: PLAYER_NAME,
    });
    expect(retry.statusCode).toBe(409);
    expect(retry.json().error.code).toBe('CHALLENGE_CONSUMED');
    expect(await SessionModel.countDocuments({})).toBe(0);
  });

  it('accepts a case-insensitive username match but stores Mojang casing', async () => {
    await seedLinkedAccount();
    stubMojangJoined({ id: PLAYER_UUID_UNDASHED, name: PLAYER_NAME });

    const challenge = await createChallenge(harness.app, 'hotaruplayer');
    const { body } = await createVerifyBody(harness.app, PLAYER_NAME, {
      challenge,
      verifyUsername: 'HOTARUPLAYER',
    });

    const response = await postVerify(harness.app, body);
    expect(response.statusCode).toBe(200);
    expect(response.json<TokenResponse>().profile.username).toBe(PLAYER_NAME);
    expect((await UserModel.findOne({ minecraftUuid: PLAYER_UUID }).lean())?.username).toBe(
      PLAYER_NAME,
    );
  });

  it('fails closed when the handshake is encrypted for a different RSA key', async () => {
    stubMojangJoined();

    const challenge = await createChallenge(harness.app, PLAYER_NAME);
    const { body } = await createVerifyBody(harness.app, PLAYER_NAME, {
      challenge,
      encryptWith: foreignRsaPublicKeyBase64(),
    });

    const response = await postVerify(harness.app, body);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');

    expect(await UserModel.countDocuments({})).toBe(0);
    expect(await SessionModel.countDocuments({})).toBe(0);
    expect(await RefreshTokenModel.countDocuments({})).toBe(0);
  });

  it('fails closed when the verify token does not match the challenge', async () => {
    stubMojangJoined();

    const challenge = await createChallenge(harness.app, PLAYER_NAME);
    const { body } = await createVerifyBody(harness.app, PLAYER_NAME, {
      challenge,
      verifyTokenBytes: Buffer.from([9, 9, 9, 9]),
    });

    const response = await postVerify(harness.app, body);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect(await SessionModel.countDocuments({})).toBe(0);
  });

  it('rejects a shared secret that is not 16 bytes', async () => {
    stubMojangJoined();

    const challenge = await createChallenge(harness.app, PLAYER_NAME);
    const { body } = await createVerifyBody(harness.app, PLAYER_NAME, {
      challenge,
      sharedSecret: Buffer.from('too-short'),
    });

    const response = await postVerify(harness.app, body);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect(await SessionModel.countDocuments({})).toBe(0);
  });

  it('fails closed with 503 and no tokens when Mojang is unavailable', async () => {
    stubMojang({ status: 500 });

    const challenge = await createChallenge(harness.app, PLAYER_NAME);
    const { body } = await createVerifyBody(harness.app, PLAYER_NAME, { challenge });

    const response = await postVerify(harness.app, body);
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatchObject({ code: 'MOJANG_UNAVAILABLE', retryable: true });

    expect(response.body).not.toContain('accessToken');
    expect(await UserModel.countDocuments({})).toBe(0);
    expect(await SessionModel.countDocuments({})).toBe(0);
    expect(await RefreshTokenModel.countDocuments({})).toBe(0);
  });

  it('fails closed with 401 when Mojang does not know the session', async () => {
    stubMojang({ status: 204 });

    const challenge = await createChallenge(harness.app, PLAYER_NAME);
    const { body } = await createVerifyBody(harness.app, PLAYER_NAME, { challenge });

    const response = await postVerify(harness.app, body);
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('NOT_A_PREMIUM_SESSION');
    expect(await SessionModel.countDocuments({})).toBe(0);
  });

  it('refuses a banned account without creating a session', async () => {
    await UserModel.create({
      minecraftUuid: PLAYER_UUID,
      username: PLAYER_NAME,
      status: 'banned',
      banReason: 'integration test',
    });
    stubMojangJoined();

    const { body } = await createVerifyBody(harness.app, PLAYER_NAME);
    const response = await postVerify(harness.app, body);

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('USER_BANNED');
    expect(await SessionModel.countDocuments({})).toBe(0);
    expect(await RefreshTokenModel.countDocuments({})).toBe(0);

    const events = (await AuditLogModel.find({}).lean()).map((entry) => entry.event);
    expect(events).toContain('auth.login.banned');
  });
});
