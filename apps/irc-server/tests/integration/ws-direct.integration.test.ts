import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, type JWK, type KeyObject } from 'jose';
import { WebSocket, type RawData } from 'ws';
import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { buildApp, type BuiltApp } from '../../src/app.js';
import type { AppContext } from '../../src/context.js';
import { connectMongo, disconnectMongo } from '../../src/infrastructure/mongo/connection.js';
import { closeRedis, createRedis } from '../../src/infrastructure/redis/client.js';
import { createRuntime } from '../../src/runtime/index.js';
import { Types } from 'mongoose';

/**
 * Integration test for the SRP v1 transport: a real HTTP server, real WebSocket
 * upgrades, a real MongoDB/Redis, and a locally signed JWKS so no auth server is
 * needed. Everything asserted here is behaviour a client can observe.
 */

const ISSUER = 'http://localhost:3000';
const AUDIENCE = 'skymatrix-api';
const DB = 'skymatrix_irc_test';

let jwksServer: Server;
let jwksUrl = '';
let privateKey: KeyObject;
let publicJwk: JWK;
let built: BuiltApp;
let ctx: AppContext;
let port = 0;

const USER_A = { sub: '6aed000000000000000000a1', uuid: '4c1099df-e202-4e64-9ea2-9039be420143' };
const USER_B = { sub: '6aed000000000000000000b2', uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
const USER_C = { sub: '6aed000000000000000000c3', uuid: '11111111-2222-4333-8444-555555555555' };

async function startJwksServer(): Promise<string> {
  const { publicKey, privateKey: priv } = await generateKeyPair('EdDSA', { extractable: true });
  privateKey = priv as KeyObject;
  publicJwk = { ...(await exportJWK(publicKey as KeyObject)), kid: 'test-key', use: 'sig', alg: 'EdDSA' };

  const server = createServer((request, response) => {
    if (request.url === '/jwks') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    response.writeHead(404).end();
  });
  jwksServer = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : 0;
  return `http://127.0.0.1:${boundPort}/jwks`;
}

async function signToken(options: {
  sub: string;
  uuid: string;
  scopes?: string[];
  expiresIn?: string;
  sessionId?: string;
}): Promise<string> {
  return new SignJWT({
    minecraft_uuid: options.uuid,
    sid: options.sessionId ?? new Types.ObjectId().toHexString(),
    scope: (options.scopes ?? ['skymatrix:profile', 'skymatrix:ircserver']).join(' '),
    jti: new Types.ObjectId().toHexString(),
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'test-key' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(options.sub)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '5m')
    .sign(privateKey);
}

function testConfig(overrides: Partial<Record<string, string>> = {}): AppConfig {
  return loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    MONGODB_URI: 'mongodb://127.0.0.1:27017',
    MONGODB_DB: DB,
    REDIS_URL: 'redis://127.0.0.1:16379',
    AUTH_JWKS_URL: jwksUrl,
    JWT_ISSUER: ISSUER,
    JWT_AUDIENCE: AUDIENCE,
    INSTANCE_ID: 'irc-test',
    ADMIN_UUIDS: USER_C.uuid,
    LOG_LEVEL: 'silent',
    HEARTBEAT_INTERVAL_MS: '60000',
    PONG_TIMEOUT_MS: '60000',
    MAX_CONNECTIONS_PER_USER: '50',
    MAX_CONNECTIONS_PER_IP: '200',
    MESSAGE_RATE_PER_SEC: '1000',
    MESSAGE_BURST: '1000',
    ...overrides,
  });
}

const openClients: Client[] = [];

interface Client {
  socket: WebSocket;
  frames: Array<Record<string, unknown>>;
  ready: Promise<Record<string, unknown>>;
  close(): void;
}

function connect(token: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/connect`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const frames: Array<Record<string, unknown>> = [];
    let resolveReady: (frame: Record<string, unknown>) => void = () => {};
    const ready = new Promise<Record<string, unknown>>((res) => {
      resolveReady = res;
    });

    socket.on('message', (raw: RawData) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      frames.push(frame);
      if (frame.op === 'READY') resolveReady(frame);
    });
    socket.on('unexpected-response', (_request, response) => {
      let body = '';
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => {
        reject(new Error(`HTTP ${response.statusCode}: ${body}`));
      });
    });
    socket.on('error', reject);
    socket.on('open', () => {
      void ready.then(() => {
        const client: Client = {
          socket,
          frames,
          ready,
          close: () => socket.close(),
        };
        // Tracked so afterAll can terminate anything a failed test left behind.
        openClients.push(client);
        resolve(client);
      });
    });
  });
}

/** Waits until a frame matching the predicate arrives (or fails the test). */
async function waitFor(
  client: Client,
  predicate: (frame: Record<string, unknown>) => boolean,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = client.frames.find(predicate);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`timed out; frames=${JSON.stringify(client.frames)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeAll(async () => {
  jwksUrl = await startJwksServer();
  const config = testConfig();
  await connectMongo(config);
  // Isolate this run from previous ones.
  const mongoose = await import('mongoose');
  await mongoose.default.connection.db?.dropDatabase();

  ctx = { config, redis: createRedis(config), instanceId: config.instanceId, now: () => Date.now() };
  // Dedupe/presence live in the shared Redis; clear only this server's namespace so
  // a previous run cannot make a "new" message look like a replay.
  try {
    if (ctx.redis.status !== 'ready') {
      await new Promise<void>((resolve) => ctx.redis.once('ready', () => resolve()));
    }
    const staleKeys = await ctx.redis.keys('irc:*');
    if (staleKeys.length > 0) await ctx.redis.del(...staleKeys);
  } catch {
    // Best effort: a cold Redis must not fail the suite setup.
  }
  const runtime = createRuntime(ctx);
  built = await buildApp(ctx, runtime);
  await built.app.listen({ host: '127.0.0.1', port: 0 });
  const address = built.app.server.address();
  port = typeof address === 'object' && address ? address.port : 0;
}, 60_000);

afterAll(async () => {
  for (const client of openClients.splice(0)) {
    try {
      client.socket.terminate();
    } catch {
      /* already gone */
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  await built?.ws.close();
  await built?.app.close();
  await closeRedis();
  await disconnectMongo();
  await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
});

describe('WebSocket upgrade authentication', () => {
  it('rejects a connection without a token', async () => {
    await expect(
      new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/connect`);
        socket.on('unexpected-response', (_req, res) => {
          res.resume();
          reject(new Error(String(res.statusCode)));
        });
        socket.on('open', resolve);
        socket.on('error', reject);
      }),
    ).rejects.toThrow('401');
  });

  it('rejects a token that lacks skymatrix:ircserver', async () => {
    const token = await signToken({ ...USER_A, scopes: ['skymatrix:profile'] });
    await expect(connect(token)).rejects.toThrow('403');
  });

  it('rejects an expired token', async () => {
    const token = await signToken({ ...USER_A, expiresIn: '-1s' });
    await expect(connect(token)).rejects.toThrow('401');
  });

  it('rejects a token signed by an unknown key', async () => {
    const other = await generateKeyPair('EdDSA');
    const forged = await new SignJWT({ minecraft_uuid: USER_A.uuid, sid: 'x', scope: 'skymatrix:ircserver' })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(USER_A.sub)
      .setExpirationTime('5m')
      .sign(other.privateKey);
    await expect(connect(forged)).rejects.toThrow('401');
  });

  it('rejects a revoked session', async () => {
    const sessionId = new Types.ObjectId().toHexString();
    const token = await signToken({ ...USER_A, sessionId });
    await ctx.redis.set(`auth:session:revoked:${sessionId}`, '1', 'EX', 60);

    await expect(connect(token)).rejects.toThrow('403');
    await ctx.redis.del(`auth:session:revoked:${sessionId}`);
  });
});

describe('SRP v1 message flow', () => {
  it('sends READY on connect', async () => {
    const token = await signToken(USER_A);
    const client = await connect(token);
    const ready = await client.ready;
    expect(ready.op).toBe('READY');
    const payload = ready.payload as Record<string, unknown>;
    expect(payload.minecraftUuid).toBe(USER_A.uuid);
    expect(payload.instanceId).toBe('irc-test');
    expect(typeof payload.connectionId).toBe('string');
    client.close();
  });

  it('delivers a DIRECT message and acknowledges both stages', async () => {
    const [clientA, clientB] = await Promise.all([connect(await signToken(USER_A)), connect(await signToken(USER_B))]);
    await Promise.all([clientA.ready, clientB.ready]);

    const messageId = 'msg-direct-1';
    clientA.socket.send(
      JSON.stringify({
        v: 1,
        id: messageId,
        op: 'MESSAGE',
        type: 'chat.message',
        route: { mode: 'DIRECT', target: USER_B.uuid },
        payload: { text: 'hello' },
        ttlMs: 10_000,
      }),
    );

    const received = await waitFor(clientB, (frame) => frame.op === 'MESSAGE');
    const payload = received.payload as Record<string, unknown>;
    expect(payload).toEqual({ text: 'hello' });
    const sender = received.sender as Record<string, unknown>;
    expect(sender.minecraftUuid).toBe(USER_A.uuid);

    const accepted = await waitFor(
      clientA,
      (frame) => frame.op === 'ACK' && (frame.payload as Record<string, unknown>).status === 'accepted',
    );
    expect(accepted.replyTo).toBe(messageId);

    const delivered = await waitFor(
      clientA,
      (frame) => frame.op === 'ACK' && (frame.payload as Record<string, unknown>).status === 'delivered',
    );
    expect((delivered.payload as Record<string, unknown>).recipients).toBeGreaterThanOrEqual(1);

    clientA.close();
    clientB.close();
  });

  it('reports TARGET_OFFLINE for a player who is not connected', async () => {
    const clientA = await connect(await signToken(USER_A));
    await clientA.ready;
    clientA.socket.send(
      JSON.stringify({
        v: 1,
        id: 'msg-offline-1',
        op: 'MESSAGE',
        type: 'chat.message',
        route: { mode: 'DIRECT', target: '99999999-8888-4777-8666-555555555555' },
        payload: { text: 'anyone?' },
      }),
    );
    const failed = await waitFor(
      clientA,
      (frame) => frame.op === 'ACK' && (frame.payload as Record<string, unknown>).status === 'failed',
    );
    expect((failed.payload as Record<string, unknown>).reason).toBe('TARGET_OFFLINE');
    clientA.close();
  });

  it('rejects a duplicate message id with a different payload', async () => {
    const [clientA, clientB] = await Promise.all([connect(await signToken(USER_A)), connect(await signToken(USER_B))]);
    await Promise.all([clientA.ready, clientB.ready]);
    const frame = {
      v: 1,
      id: 'dup-1',
      op: 'MESSAGE',
      type: 'chat.message',
      route: { mode: 'DIRECT', target: USER_B.uuid },
      payload: { text: 'first' },
    };
    clientA.socket.send(JSON.stringify(frame));
    await waitFor(clientA, (f) => f.op === 'ACK' && (f.payload as Record<string, unknown>).status === 'delivered');

    clientA.socket.send(JSON.stringify({ ...frame, payload: { text: 'second' } }));
    const failed = await waitFor(
      clientA,
      (f) => f.op === 'ACK' && (f.payload as Record<string, unknown>).reason === 'DUPLICATE_MESSAGE_ID',
    );
    expect((failed.payload as Record<string, unknown>).status).toBe('failed');

    clientA.close();
    clientB.close();
  });

  it('rejects an invalid message type', async () => {
    const clientA = await connect(await signToken(USER_A));
    await clientA.ready;
    clientA.socket.send(
      JSON.stringify({
        v: 1,
        id: 'bad-type-1',
        op: 'MESSAGE',
        type: 'protocol.ack',
        route: { mode: 'DIRECT', target: USER_B.uuid },
        payload: {},
      }),
    );
    const error = await waitFor(clientA, (frame) => frame.op === 'ERROR');
    expect((error.payload as Record<string, unknown>).code).toBe('INVALID_TYPE');
    clientA.close();
  });

  it('rate-limits a flood', async () => {
    // Separate app instance so the strict limit does not affect the other tests.
    const strictConfig = testConfig({ MESSAGE_RATE_PER_SEC: '1', MESSAGE_BURST: '2' });
    const strictCtx: AppContext = {
      config: strictConfig,
      redis: ctx.redis,
      instanceId: 'irc-test-strict',
      now: () => Date.now(),
    };
    const strictBuilt = await buildApp(strictCtx, createRuntime(strictCtx));
    await strictBuilt.app.listen({ host: '127.0.0.1', port: 0 });
    const address = strictBuilt.app.server.address();
    const strictPort = typeof address === 'object' && address ? address.port : 0;

    const token = await signToken(USER_A);
    const socket = new WebSocket(`ws://127.0.0.1:${strictPort}/v1/connect`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const frames: Array<Record<string, unknown>> = [];
    socket.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    for (let index = 0; index < 6; index += 1) {
      socket.send(
        JSON.stringify({
          v: 1,
          id: `flood-${index}`,
          op: 'MESSAGE',
          type: 'chat.message',
          route: { mode: 'DIRECT', target: USER_B.uuid },
          payload: { index },
        }),
      );
    }

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !frames.some((f) => f.op === 'ERROR')) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const error = frames.find((frame) => frame.op === 'ERROR');
    expect((error?.payload as Record<string, unknown>).code).toBe('RATE_LIMITED');

    socket.close();
    await strictBuilt.ws.close();
    await strictBuilt.app.close();
  });
});
