import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Redis } from 'ioredis';
import { loadConfig } from '../../src/config/env.js';
import type { AppContext } from '../../src/context.js';
import { buildApp } from '../../src/app.js';
import { createRuntime } from '../../src/runtime/index.js';
import type { FastifyInstance } from 'fastify';

/**
 * Shared harness for the REST route suites (`groups-rest.test.ts`,
 * `filters-rest.test.ts`).
 *
 * It boots the *real* app (`buildApp` + `createRuntime`) against a local JWKS
 * stub, so the routes are exercised exactly as a client hits them: real
 * `requireAuth` verification (signature, iss/aud, Redis revocation lookup), real
 * Zod/Fastify validation, real serialisation and the real error handler. Only the
 * network hop is skipped (`app.inject`).
 *
 * The tokens are signed with a throwaway Ed25519 key minted per harness; nothing
 * here is reused outside the test process.
 */

const MONGO_URI = process.env['IRC_TEST_MONGODB_URI'] ?? 'mongodb://127.0.0.1:27017';
const DB_NAME = 'hotaru_irc_test';
const REDIS_URL = process.env['IRC_TEST_REDIS_URL'] ?? 'redis://127.0.0.1:16379';
const KID = 'irc-groups-test-key';

export interface TokenIdentity {
  minecraftUuid: string;
  userId: string;
  token: string;
}

export interface RestResponse {
  status: number;
  body: unknown;
  headers: Record<string, unknown>;
}

export interface RestHarness {
  app: FastifyInstance;
  identity(minecraftUuid: string, userId?: string): Promise<TokenIdentity>;
  call(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    identity?: TokenIdentity | null,
    payload?: unknown,
  ): Promise<RestResponse>;
  close(): Promise<void>;
}

export interface RestHarnessOptions {
  adminUuids?: string[];
  /**
   * Overrides `CREATE_GROUP_PER_HOUR`. Defaults to a deliberately high value: the
   * suites create many groups as the same test player, and the quota window lives
   * in Redis (so it survives re-runs within the same hour).
   */
  createGroupPerHour?: number;
  /**
   * Replaces `ctx.redis` with a test double. The REST path only needs
   * `exists` (session revocation) and `multi` (the group-creation quota).
   */
  redis?: unknown;
}

export function testMongoUri(): string {
  return `${MONGO_URI}/${DB_NAME}`;
}

export function testDbName(): string {
  return DB_NAME;
}

export async function startRestHarness(options: RestHarnessOptions = {}): Promise<RestHarness> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);

  const jwksServer: Server = createServer((request, response) => {
    if (request.url !== '/jwks') {
      response.statusCode = 404;
      response.end('not found');
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ keys: [{ ...publicJwk, kid: KID, alg: 'EdDSA', use: 'sig' }] }));
  });

  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', () => resolve()));
  const jwksPort = (jwksServer.address() as AddressInfo).port;

  const config = loadConfig({
    NODE_ENV: 'test',
    MONGODB_URI: MONGO_URI,
    MONGODB_DB: DB_NAME,
    REDIS_URL,
    AUTH_JWKS_URL: `http://127.0.0.1:${jwksPort}/jwks`,
    ADMIN_UUIDS: (options.adminUuids ?? []).join(','),
    MAX_GROUP_MEMBERS: '10',
    CREATE_GROUP_PER_HOUR: String(options.createGroupPerHour ?? 1_000),
    LOG_LEVEL: 'error',
  } as NodeJS.ProcessEnv);

  const ownsRedis = options.redis === undefined;
  const redis = (ownsRedis
    ? new Redis(REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2 })
    : options.redis) as Redis;
  const ctx: AppContext = { config, redis, instanceId: 'rest-test', now: () => Date.now() };
  const runtime = createRuntime(ctx);
  const built = await buildApp(ctx, runtime);

  async function identity(minecraftUuid: string, userId = `user-${minecraftUuid.slice(0, 8)}`) {
    const token = await new SignJWT({
      sid: `sess-${userId}`,
      minecraft_uuid: minecraftUuid,
      scope: 'hotaru:ircserver',
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: KID })
      .setIssuer(config.jwtIssuer)
      .setAudience(config.jwtAudience)
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey);

    return { minecraftUuid, userId, token };
  }

  async function call(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    who?: TokenIdentity | null,
    payload?: unknown,
  ): Promise<RestResponse> {
    const headers: Record<string, string> = {};
    if (who) headers['authorization'] = `Bearer ${who.token}`;

    const response = await built.app.inject({
      method,
      url,
      headers,
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

    let body: unknown = null;
    if (response.body.length > 0) {
      try {
        body = JSON.parse(response.body);
      } catch {
        body = response.body;
      }
    }
    return { status: response.statusCode, body, headers: response.headers };
  }

  async function close(): Promise<void> {
    await built.ws.close();
    await built.app.close();
    await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
    if (ownsRedis) await redis.quit().catch(() => undefined);
  }

  return { app: built.app, identity, call, close };
}
