import {
  constants,
  createPublicKey,
  generateKeyPairSync,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';
import { vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { ChallengeResponse, TokenResponse } from '@hotaru/api-contract';
import { buildApp } from '../../../src/app.js';
import { loadConfig, type AppConfig } from '../../../src/config/env.js';
import type { AppContext } from '../../../src/context.js';
import { initKeys } from '../../../src/infrastructure/crypto/keys.js';
import { connectMongo, disconnectMongo } from '../../../src/infrastructure/mongo/connection.js';
import { createRedis, closeRedis } from '../../../src/infrastructure/redis/client.js';
import {
  ActivationCodeUseModel,
  AuditLogModel,
  MinecraftBindingCodeModel,
  MinecraftLinkModel,
  PermissionModel,
  RefreshTokenModel,
  SessionModel,
  UserModel,
} from '../../../src/infrastructure/mongo/models/index.js';

/**
 * Bootstrap for the auth-core integration tests. They run against the real
 * MongoDB and Redis containers — the point is to exercise the actual Lua
 * scripts, indexes and TTLs, not a mock that agrees with the implementation.
 *
 * Redis is published on host port 16379 in this environment (6379 cannot be
 * bound by the Docker Desktop proxy here); override with TEST_REDIS_URL.
 */
export const TEST_MONGODB_URI = process.env.TEST_MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
export const TEST_MONGODB_DB = process.env.TEST_MONGODB_DB ?? 'hotaru_auth_test';
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:16379';

export const PLAYER_UUID = '01234567-89ab-cdef-0123-456789abcdef';
export const PLAYER_UUID_UNDASHED = PLAYER_UUID.replace(/-/g, '');
export const PLAYER_NAME = 'HotaruPlayer';
export const DEFAULT_SCOPES = ['hotaru:profile', 'hotaru:resource'];

export interface AuthCoreHarness {
  app: FastifyInstance;
  ctx: AppContext;
  config: AppConfig;
  redis: Redis;
}

export type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  PUBLIC_BASE_URL: 'http://localhost:3000',
  JWT_AUDIENCE: 'hotaru-api',
  ACCESS_TOKEN_TTL_SECONDS: '900',
  REFRESH_TOKEN_TTL_DAYS: '7',
  CHALLENGE_TTL_SECONDS: '10',
  RATE_LIMIT_WINDOW_SECONDS: '60',
  RATE_LIMIT_CHALLENGE_MAX: '1000',
  RATE_LIMIT_VERIFY_MAX: '1000',
  MOJANG_SESSION_SERVER: 'https://sessionserver.mojang.com',
  MOJANG_HAS_JOINED_TIMEOUT_MS: '2000',
  // One attempt, no delay: the network is stubbed, retries only slow tests.
  MOJANG_HAS_JOINED_ATTEMPTS: '1',
  MOJANG_RETRY_DELAY_MS: '0',
  DEFAULT_SCOPES: DEFAULT_SCOPES.join(','),
  CORS_ORIGINS: '',
};

export async function startHarness(
  overrides: Record<string, string> = {},
): Promise<AuthCoreHarness> {
  const config = loadConfig({
    ...process.env,
    ...BASE_ENV,
    MONGODB_URI: TEST_MONGODB_URI,
    MONGODB_DB: TEST_MONGODB_DB,
    REDIS_URL: TEST_REDIS_URL,
    ...overrides,
  });

  await connectMongo(config);
  // The account model replaced the old non-partial unique indexes. Tests use a
  // persistent database, so synchronize the schema indexes before the first insert.
  await UserModel.syncIndexes();
  const redis = createRedis(config);
  await new Promise<void>((resolve, reject) => {
    if (redis.status === 'ready') {
      resolve();
      return;
    }
    const onReady = (): void => {
      redis.off('error', onError);
      resolve();
    };
    const onError = (error: Error): void => {
      redis.off('ready', onReady);
      reject(error);
    };
    redis.once('ready', onReady);
    redis.once('error', onError);
  });
  await purgeAuthCoreData(redis);

  const keys = await initKeys(config);
  const ctx: AppContext = { config, keys, redis };
  const app = await buildApp(ctx);
  await app.ready();

  return { app, ctx, config, redis };
}

export async function stopHarness(harness: AuthCoreHarness): Promise<void> {
  await harness.app.close();
  await purgeAuthCoreData(harness.redis);
  await closeRedis();
  await disconnectMongo();
}

/** Removes only the data the auth-core flows write (service keys are kept). */
export async function purgeAuthCoreData(redis: Redis): Promise<void> {
  await Promise.all([
    UserModel.deleteMany({}),
    PermissionModel.deleteMany({}),
    SessionModel.deleteMany({}),
    RefreshTokenModel.deleteMany({}),
    AuditLogModel.deleteMany({}),
    MinecraftLinkModel.deleteMany({}),
    MinecraftBindingCodeModel.deleteMany({}),
    ActivationCodeUseModel.deleteMany({}),
  ]);

  for (const pattern of [
    'auth:challenge:*',
    'auth:challenge:state:*',
    'auth:rate:*',
    'auth:session:revoked:*',
  ]) {
    await deleteKeysByPattern(redis, pattern);
  }
}

async function deleteKeysByPattern(redis: Redis, pattern: string): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

export async function postChallenge(
  app: FastifyInstance,
  username: string,
  headers: Record<string, string> = {},
): Promise<InjectResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/minecraft/challenge',
    headers,
    payload: { username },
  });
}

export async function postVerify(
  app: FastifyInstance,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<InjectResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/minecraft/verify',
    headers,
    payload: body as Record<string, unknown>,
  });
}

export async function postRefresh(
  app: FastifyInstance,
  refreshToken: string,
): Promise<InjectResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/refresh',
    payload: { refreshToken },
  });
}

export async function postLogout(
  app: FastifyInstance,
  accessToken: string,
): Promise<InjectResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/logout',
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

/** Creates a challenge and returns the parsed body (asserts it succeeded). */
export async function createChallenge(
  app: FastifyInstance,
  username: string,
): Promise<ChallengeResponse> {
  const response = await postChallenge(app, username);
  if (response.statusCode !== 200) {
    throw new Error(`challenge failed: ${response.statusCode} ${response.body}`);
  }
  return response.json<ChallengeResponse>();
}

/** Full handshake: challenge -> encrypted payload with the service public key. */
export async function createVerifyBody(
  app: FastifyInstance,
  username: string,
  options: {
    challenge?: ChallengeResponse;
    /** Encrypt with this base64 DER key instead of the challenge's key. */
    encryptWith?: string;
    sharedSecret?: Buffer;
    verifyTokenBytes?: Buffer;
    verifyUsername?: string;
  } = {},
): Promise<{ challenge: ChallengeResponse; body: Record<string, string> }> {
  const challenge = options.challenge ?? (await createChallenge(app, username));
  const publicKeyBase64 = options.encryptWith ?? challenge.publicKey;
  const sharedSecret = options.sharedSecret ?? randomBuffer(16);
  const verifyToken = options.verifyTokenBytes ?? Buffer.from(challenge.verifyToken, 'base64');

  return {
    challenge,
    body: {
      challengeId: challenge.challengeId,
      username: options.verifyUsername ?? username,
      encryptedSharedSecret: encryptForPublicKey(publicKeyBase64, sharedSecret).toString('base64'),
      encryptedVerifyToken: encryptForPublicKey(publicKeyBase64, verifyToken).toString('base64'),
    },
  };
}

export function randomBuffer(bytes: number): Buffer {
  return randomBytes(bytes);
}

/**
 * Creates the account/link fixture that the post-link login flow requires.
 * Tests that specifically exercise an unlinked UUID must not call this.
 */
export async function seedLinkedAccount(options: {
  uuid?: string;
  username?: string;
  scopes?: string[];
  status?: 'active' | 'banned';
} = {}): Promise<{ userId: string; minecraftUuid: string }> {
  const uuid = options.uuid ?? PLAYER_UUID;
  const username = options.username ?? PLAYER_NAME;
  const status = options.status ?? 'active';
  const user = await UserModel.findOneAndUpdate(
    { minecraftUuid: uuid },
    {
      $set: { username, status },
      $setOnInsert: { loginName: null, passwordHash: null },
    },
    { upsert: true, new: true },
  );
  const now = new Date();
  await MinecraftLinkModel.findOneAndUpdate(
    { minecraftUuid: uuid },
    {
      $set: {
        accountId: user._id,
        minecraftUsername: username,
        status: status === 'banned' ? 'banned' : 'active',
      },
      $setOnInsert: { verifiedAt: now, linkedAt: now },
    },
    { upsert: true, new: true },
  );
  for (const scope of options.scopes ?? DEFAULT_SCOPES) {
    await PermissionModel.updateOne(
      { userId: user._id, scope },
      { $setOnInsert: { userId: user._id, scope, expiresAt: null, grantedBy: null } },
      { upsert: true },
    );
  }
  return { userId: String(user._id), minecraftUuid: uuid };
}

export function encryptForPublicKey(publicKeyBase64: string, plaintext: Buffer): Buffer {
  const key = createPublicKey({
    key: Buffer.from(publicKeyBase64, 'base64'),
    format: 'der',
    type: 'spki',
  });
  return publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, plaintext);
}

/** A valid RSA-1024 public key that is NOT the service key (for negative tests). */
export function foreignRsaPublicKeyBase64(): string {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}

/* ------------------------------------------------------------------ */
/* Mojang stubbing                                                     */
/* ------------------------------------------------------------------ */

export interface MojangStubResponse {
  status: number;
  body?: unknown;
}

/**
 * Replaces global fetch. The real Mojang client runs against the stub, so URL
 * building, status mapping (204/4xx -> null, 5xx -> MOJANG_UNAVAILABLE) and
 * retry policy are exercised for real.
 */
export function stubMojang(response: MojangStubResponse): void {
  const fetchStub = vi.fn(async () => {
    if (response.status === 200) {
      return new Response(JSON.stringify(response.body ?? {}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(null, { status: response.status });
  });
  vi.stubGlobal('fetch', fetchStub);
}

export function stubMojangJoined(profile: { id: string; name: string } = {
  id: PLAYER_UUID_UNDASHED,
  name: PLAYER_NAME,
}): void {
  stubMojang({ status: 200, body: profile });
}

/** Finds the id of the session that owns a refresh token, for DB assertions. */
export async function sessionIdOfRefreshToken(refreshToken: string): Promise<string> {
  const { hashRefreshToken } = await import('../../../src/modules/tokens/refresh-token.js');
  const token = await RefreshTokenModel.findOne({ tokenHash: hashRefreshToken(refreshToken) }).lean();
  if (!token) throw new Error('refresh token document not found');
  return String(token.sessionId);
}

export type { TokenResponse, ChallengeResponse };
