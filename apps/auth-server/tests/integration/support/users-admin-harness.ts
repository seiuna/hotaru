import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import type { AppContext } from '../../../src/context.js';
import { buildApp } from '../../../src/app.js';
import { loadConfig, type AppConfig } from '../../../src/config/env.js';
import { initKeys } from '../../../src/infrastructure/crypto/keys.js';
import { connectMongo, disconnectMongo } from '../../../src/infrastructure/mongo/connection.js';
import { createRedis, closeRedis } from '../../../src/infrastructure/redis/client.js';
import {
  AuditLogModel,
  PermissionModel,
  RefreshTokenModel,
  SessionModel,
  UserModel,
} from '../../../src/infrastructure/mongo/models/index.js';
import { revocationKey } from '../../../src/plugins/auth.js';

/**
 * Shared bootstrap for the users/admin integration tests. They talk to the real
 * containers (never a mock) so the security-critical behaviour — scopes read
 * from MongoDB, Redis revocation keys — is exercised for real.
 *
 * Redis listens on host port 16379 in this environment; override with
 * TEST_REDIS_URL / TEST_MONGODB_* when the containers move.
 */
export const TEST_MONGODB_URI = process.env.TEST_MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
export const TEST_MONGODB_DB = process.env.TEST_MONGODB_DB ?? 'skymatrix_auth_test';
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:16379';

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
}

export interface SeededUser {
  id: string;
  minecraftUuid: string;
  username: string;
  accessToken: string;
  sessionId: string;
}

function testConfig(): AppConfig {
  return loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    MONGODB_URI: TEST_MONGODB_URI,
    MONGODB_DB: TEST_MONGODB_DB,
    REDIS_URL: TEST_REDIS_URL,
  });
}

export async function startHarness(): Promise<Harness> {
  const config = testConfig();
  await connectMongo(config);
  const keys = await initKeys(config);
  const redis = createRedis(config);
  const ctx: AppContext = { config, keys, redis };
  const app = await buildApp(ctx);
  await app.ready();
  return { app, ctx };
}

export async function stopHarness(harness: Harness): Promise<void> {
  await harness.app.close();
  await closeRedis();
  await disconnectMongo();
}

/** Tracks everything a test created so cleanup can be exact, not a database wipe. */
export class TestData {
  private readonly userIds = new Set<string>();
  private readonly sessionIds = new Set<string>();
  private readonly usernames = new Set<string>();

  constructor(private readonly ctx: AppContext) {}

  newUsername(prefix: string): string {
    // Minecraft usernames are 3-16 chars of [A-Za-z0-9_].
    for (;;) {
      const unique = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`.slice(-10);
      const username = `${prefix}${unique}`.slice(0, 16);
      if (!this.usernames.has(username)) {
        this.usernames.add(username);
        return username;
      }
    }
  }

  async createUser(options: {
    username?: string;
    status?: 'active' | 'banned';
    scopes?: Array<{ scope: string; expiresAt?: Date | null }>;
  } = {}): Promise<SeededUser> {
    const username = options.username ?? this.newUsername('u');
    const minecraftUuid = randomUUID();
    const user = await UserModel.create({
      minecraftUuid,
      username,
      status: options.status ?? 'active',
    });
    const id = String(user._id);
    this.userIds.add(id);

    for (const grant of options.scopes ?? []) {
      await PermissionModel.create({
        userId: user._id,
        scope: grant.scope,
        expiresAt: grant.expiresAt ?? null,
        grantedBy: 'test',
      });
    }

    const session = await SessionModel.create({
      userId: user._id,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });
    const sessionId = String(session._id);
    this.sessionIds.add(sessionId);

    const accessToken = await this.mintAccessToken({
      userId: id,
      minecraftUuid,
      sessionId,
      scopes: [],
    });

    return { id, minecraftUuid, username, accessToken, sessionId };
  }

  async grant(userId: string, scope: string, expiresAt: Date | null = null): Promise<void> {
    await PermissionModel.create({ userId, scope, expiresAt, grantedBy: 'test' });
  }

  /**
   * Signs an access token exactly like the token module does. The `scope` claim
   * is deliberately caller-controlled: the API must ignore it and read scopes
   * from MongoDB instead.
   */
  async mintAccessToken(params: {
    userId: string;
    minecraftUuid: string;
    sessionId: string;
    scopes?: string[];
    expiresInSeconds?: number;
  }): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const token = new SignJWT({
      minecraft_uuid: params.minecraftUuid,
      sid: params.sessionId,
      jti: randomUUID(),
      scope: (params.scopes ?? []).join(' '),
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: this.ctx.keys.jwt.kid })
      .setIssuer(this.ctx.config.jwtIssuer)
      .setAudience(this.ctx.config.jwtAudience)
      .setSubject(params.userId)
      .setIssuedAt(now)
      .setExpirationTime(now + (params.expiresInSeconds ?? this.ctx.config.accessTokenTtlSeconds))
      .sign(this.ctx.keys.jwt.privateKey);
    return await token;
  }

  /** Removes every document/redis key the test created. */
  async cleanup(): Promise<void> {
    const userIds = [...this.userIds];
    const sessionIds = [...this.sessionIds];

    if (sessionIds.length > 0) {
      await this.ctx.redis.del(...sessionIds.map((sessionId) => revocationKey(sessionId)));
    }
    if (userIds.length > 0 || sessionIds.length > 0) {
      await PermissionModel.deleteMany({ userId: { $in: userIds } });
      await RefreshTokenModel.deleteMany({
        $or: [{ userId: { $in: userIds } }, { sessionId: { $in: sessionIds } }],
      });
      await SessionModel.deleteMany({
        $or: [{ userId: { $in: userIds } }, { _id: { $in: sessionIds } }],
      });
      await AuditLogModel.deleteMany({
        $or: [
          { targetId: { $in: [...userIds, ...sessionIds] } },
          { actorId: { $in: userIds.map((id) => new Types.ObjectId(id)) } },
        ],
      });
      await UserModel.deleteMany({ _id: { $in: userIds } });
    }

    this.userIds.clear();
    this.sessionIds.clear();
    this.usernames.clear();
  }
}

export function bearer(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}` };
}
