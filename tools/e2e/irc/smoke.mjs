#!/usr/bin/env node
/**
 * SRP v1 end-to-end smoke test — real WebSocket, real JWTs, no stubs.
 *
 * Default (managed) mode boots a disposable stack on loopback with throwaway
 * MongoDB databases (see stack.mjs):
 *
 *   fake Mojang -> auth#1 (profile+ircserver scopes) / auth#2 (no irc scope)
 *               / auth#3 (1s token TTL) -> irc-server
 *
 * and then drives the server the way a mod client does:
 *
 *   upgrade -> READY -> DIRECT MESSAGE (+ACK accepted/delivered) -> recipient frame
 *   -> dedupe replay -> forged/expired/scope-less/revoked upgrades -> RATE_LIMITED
 *   -> TARGET_OFFLINE -> REST health/presence -> graceful shutdown
 *
 * External mode (--external, or IRC_TEST_TOKEN_A/B) talks to a running pair
 * instead; tokens are either passed in or minted through the real Mojang flow
 * with TEST_ACCESSTOKEN (same logic as tools/e2e/mint-token.mjs).
 *
 * Usage:
 *   node tools/e2e/irc/smoke.mjs                     # hermetic
 *   node tools/e2e/irc/smoke.mjs --external \
 *        --auth http://127.0.0.1:3000 --url ws://127.0.0.1:3001/v1/connect
 *   IRC_TEST_TOKEN_A=... IRC_TEST_TOKEN_B=... node tools/e2e/irc/smoke.mjs
 *
 * Exit codes: 0 = every check passed, 1 = at least one check failed,
 * 2 = the harness could not run (infrastructure/service unavailable).
 * Tokens are never printed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { mintFromRealMojang, startManagedStack } from './stack.mjs';
import { SrpClient, decodeJwtPayload, loadWebSocket, probeUpgrade, repoRoot, settle } from './ws-client.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const EXTERNAL = flag('external') || Boolean(process.env.IRC_TEST_TOKEN_A);
// Rewritten to the managed stack's own URLs when it boots one.
let WS_URL = option('url', process.env.IRC_TEST_WS_URL ?? 'ws://127.0.0.1:3001/v1/connect');
let HTTP_URL = option('http', process.env.IRC_TEST_HTTP_URL ?? 'http://127.0.0.1:3001').replace(/\/$/, '');
const AUTH_URL = (option('auth', process.env.IRC_TEST_AUTH_URL ?? 'http://127.0.0.1:3000')).replace(/\/$/, '');
const REDIS_URL = process.env.IRC_TEST_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:16379';

let checks = 0;
let failures = 0;
let skipped = 0;

function check(name, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`);
  }
  return Boolean(condition);
}

function skip(name, reason) {
  skipped += 1;
  console.log(`  SKIP  ${name} (${reason})`);
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function http(method, route, { token, body } = {}) {
  const response = await fetch(`${HTTP_URL}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: parseJson(text), text };
}

/** Reads TEST_ACCESSTOKEN the same way tools/e2e/mint-token.mjs does. */
function readAuthServerEnv(key) {
  if (process.env[key]) return process.env[key];
  const file = path.join(repoRoot, 'apps', 'auth-server', '.env');
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq).trim() === key) return trimmed.slice(eq + 1).trim();
  }
  return null;
}

async function loadRedisClient() {
  const require = createRequire(path.join(repoRoot, 'apps', 'irc-server', 'package.json'));
  const mod = await import(pathToFileURL(require.resolve('ioredis')).href);
  const Redis = mod.default?.default ?? mod.default ?? mod;
  return new Redis(REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2 });
}

/** Asserts that `probeUpgrade` was rejected with the expected status + SRP code. */
function checkUpgradeRejected(name, result, expectedStatus, expectedCode) {
  const body = parseJson(result.body);
  const ok = result.status === expectedStatus && (expectedCode ? body?.error?.code === expectedCode : true);
  check(
    name,
    ok,
    `expected HTTP ${expectedStatus}${expectedCode ? ` ${expectedCode}` : ''}, got HTTP ${result.status} ${JSON.stringify(body)}`,
  );
}

async function main() {
  const startedAt = Date.now();
  const ws = await loadWebSocket();
  console.log(`SRP v1 IRC smoke test — mode=${EXTERNAL ? 'external' : 'managed'}, client=${ws.source}`);

  let stack = null;
  let redis = null;
  const clients = [];

  const context = {
    tokenA: process.env.IRC_TEST_TOKEN_A ?? null,
    tokenB: process.env.IRC_TEST_TOKEN_B ?? null,
    tokenNoScope: process.env.IRC_TEST_TOKEN_NO_SCOPE ?? null,
    tokenExpired: process.env.IRC_TEST_TOKEN_EXPIRED ?? null,
    uuidA: null,
    uuidB: null,
    userIdA: null,
    claimsA: null,
  };

  try {
    if (EXTERNAL) {
      console.log(`WebSocket ${WS_URL}`);
      console.log(`Auth server ${AUTH_URL} (external)`);
      if (!context.tokenA || !context.tokenB) {
        const accessToken = readAuthServerEnv('TEST_ACCESSTOKEN');
        if (!accessToken) {
          throw new Error(
            'external mode needs IRC_TEST_TOKEN_A/IRC_TEST_TOKEN_B or TEST_ACCESSTOKEN in apps/auth-server/.env',
          );
        }
        console.log('minting real JWTs through the Minecraft handshake...');
        const alice = await mintFromRealMojang({ authBase: AUTH_URL, accessToken });
        const bob = await mintFromRealMojang({ authBase: AUTH_URL, accessToken });
        context.tokenA = alice.accessToken;
        context.tokenB = bob.accessToken;
      }
      context.claimsA = decodeJwtPayload(context.tokenA) ?? {};
      context.claimsB = decodeJwtPayload(context.tokenB) ?? {};
      context.uuidA = String(context.claimsA.minecraft_uuid ?? '').toLowerCase();
      context.uuidB = String(context.claimsB.minecraft_uuid ?? '').toLowerCase();
      context.userIdA = context.claimsA.sub ?? '';
    } else {
      stack = await startManagedStack({ log: (line) => console.log(`  · ${line}`) });
      // The managed stack uses its own ports so it can never collide with a dev
      // deployment on 3000/3001; point every check at it.
      HTTP_URL = stack.ircHttpUrl;
      WS_URL = stack.ircWsUrl;
      console.log(`WebSocket ${WS_URL}`);
      console.log('minting JWTs through the real Minecraft handshake (fake session server)...');
      const alice = await stack.mint({ username: 'Alice' });
      const bob = await stack.mint({ username: 'Bob' });
      const eve = await stack.mint({ username: 'Eve', from: 'restricted' });
      const mallory = await stack.mint({ username: 'Mallory', from: 'expired' });
      context.tokenA = alice.accessToken;
      context.tokenB = bob.accessToken;
      context.tokenNoScope = eve.accessToken;
      context.tokenExpired = mallory.accessToken;
      context.uuidA = alice.minecraftUuid;
      context.uuidB = bob.minecraftUuid;
      context.claimsA = decodeJwtPayload(alice.accessToken) ?? {};
      context.userIdA = context.claimsA.sub ?? '';
      // Let the 1-second token expire before it is used.
      await sleep(1600);
    }

    context.claimsA = context.claimsA ?? decodeJwtPayload(context.tokenA) ?? {};

    /* ------------------------------------------------------------------ */
    section('HTTP health + auth');
    /* ------------------------------------------------------------------ */
    const live = await http('GET', '/health/live');
    check('GET /health/live -> 200 ok', live.status === 200 && live.json?.status === 'ok', JSON.stringify(live.json));

    const ready = await http('GET', '/health/ready');
    check(
      'GET /health/ready -> mongo+redis ok',
      ready.status === 200 && ready.json?.checks?.mongo === 'ok' && ready.json?.checks?.redis === 'ok',
      JSON.stringify(ready.json),
    );
    check('readiness reports the live connection count', typeof ready.json?.connections === 'number', JSON.stringify(ready.json));

    const noAuth = await http('GET', '/v1/presence/me');
    check(
      'GET /v1/presence/me without a token -> 401 UNAUTHORIZED',
      noAuth.status === 401 && noAuth.json?.error?.code === 'UNAUTHORIZED',
      JSON.stringify(noAuth.json),
    );

    /* ------------------------------------------------------------------ */
    section('WebSocket upgrade -> READY');
    /* ------------------------------------------------------------------ */
    const a = await SrpClient.connect({ url: WS_URL, token: context.tokenA, WebSocketImpl: ws.C, label: 'A' });
    clients.push(a);
    const readyA = await a.waitForOp('READY', {}, { timeoutMs: 6000, describe: 'READY for A' });
    check(
      'client A receives READY (protocol.ready, v1)',
      readyA.v === 1 && readyA.type === 'protocol.ready' && typeof readyA.payload?.connectionId === 'string',
      JSON.stringify(readyA).slice(0, 240),
    );
    check(
      'READY carries the token identity (never client input)',
      readyA.payload?.minecraftUuid === context.uuidA && readyA.payload?.userId === context.userIdA,
      `frame=${readyA.payload?.minecraftUuid}/${readyA.payload?.userId} token=${context.uuidA}/${context.userIdA}`,
    );
    check(
      'READY advertises the heartbeat interval',
      typeof readyA.payload?.heartbeatIntervalMs === 'number' && readyA.payload.heartbeatIntervalMs > 0,
      JSON.stringify(readyA.payload),
    );

    const pingA = await http('GET', '/v1/presence/me', { token: context.tokenA });
    check(
      'presence REST sees the open socket',
      pingA.status === 200 && pingA.json?.online === true && pingA.json?.connections === 1,
      JSON.stringify(pingA.json),
    );

    const b = await SrpClient.connect({ url: WS_URL, token: context.tokenB, WebSocketImpl: ws.C, label: 'B' });
    clients.push(b);
    const readyB = await b.waitForOp('READY', {}, { timeoutMs: 6000, describe: 'READY for B' });
    check(
      'client B receives READY with its own connection id',
      readyB.payload?.connectionId && readyB.payload.connectionId !== readyA.payload.connectionId,
      `${readyA.payload?.connectionId} vs ${readyB.payload?.connectionId}`,
    );

    /* ------------------------------------------------------------------ */
    section('DIRECT message with a custom type and JSON payload');
    /* ------------------------------------------------------------------ */
    const directId = `e2e-${Date.now()}-direct`;
    const directPayload = { kind: 'e2e', n: 7, nested: { list: [1, 2, 3], ok: true }, text: 'hello 世界' };
    const directSentAt = Date.now();
    a.send({
      v: 1,
      id: directId,
      op: 'MESSAGE',
      type: 'e2e.chat.message',
      route: { mode: 'DIRECT', target: context.uuidB },
      payload: directPayload,
      replyTo: null,
    });

    const ackAccepted = await a.waitFor((frame) => frame.op === 'ACK' && frame.replyTo === directId, {
      describe: 'ACK accepted',
    });
    check('sender gets ACK accepted', ackAccepted.payload?.status === 'accepted', JSON.stringify(ackAccepted));

    const ackDelivered = await a.waitFor((frame) => frame.op === 'ACK' && frame.replyTo === directId, {
      describe: 'ACK delivered',
    });
    check(
      'sender gets ACK delivered with recipients=1',
      ackDelivered.payload?.status === 'delivered' && ackDelivered.payload?.recipients === 1,
      JSON.stringify(ackDelivered),
    );

    const delivered = await b.waitFor((frame) => frame.op === 'MESSAGE' && frame.id === directId, {
      describe: 'MESSAGE delivery',
    });
    const directDeliveryMs = Date.now() - directSentAt;
    console.log(`        measured: end-to-end DIRECT delivery ${directDeliveryMs} ms (send -> recipient frame)`);
    check('recipient receives MESSAGE with the custom type', delivered.type === 'e2e.chat.message', JSON.stringify(delivered).slice(0, 240));
    check(
      'payload arrives byte-identical (JSON round-trip)',
      JSON.stringify(delivered.payload) === JSON.stringify(directPayload),
      JSON.stringify(delivered.payload),
    );
    check(
      'sender identity is server-attested',
      delivered.sender?.minecraftUuid === context.uuidA && delivered.sender?.userId === context.userIdA,
      JSON.stringify(delivered.sender),
    );
    check(
      'route is echoed for the recipient',
      delivered.route?.mode === 'DIRECT' && delivered.route?.target === context.uuidB,
      JSON.stringify(delivered.route),
    );
    check(
      'server stamped TTL (default 10s) and expireAt = receivedAt + ttlMs',
      delivered.ttlMs === 10_000 && delivered.expireAt === delivered.receivedAt + delivered.ttlMs,
      `ttlMs=${delivered.ttlMs} receivedAt=${delivered.receivedAt} expireAt=${delivered.expireAt}`,
    );
    const aAfterDirect = await settle(a, 250);
    check(
      'sender does not receive its own DIRECT message',
      !aAfterDirect.some((frame) => frame.op === 'MESSAGE' && frame.id === directId),
      aAfterDirect.map((frame) => frame.op).join(','),
    );

    /* ------------------------------------------------------------------ */
    section('DIRECT to an offline player');
    /* ------------------------------------------------------------------ */
    const offlineId = `e2e-${Date.now()}-offline`;
    a.send({
      v: 1,
      id: offlineId,
      op: 'MESSAGE',
      type: 'e2e.chat.message',
      route: { mode: 'DIRECT', target: '00000000-0000-4000-8000-000000000000' },
      payload: { ping: true },
    });
    await a.waitFor((frame) => frame.op === 'ACK' && frame.replyTo === offlineId, { describe: 'ACK accepted (offline)' });
    const offlineAck = await a.waitFor((frame) => frame.op === 'ACK' && frame.replyTo === offlineId, {
      describe: 'ACK failed (offline)',
    });
    check(
      'offline target -> ACK failed TARGET_OFFLINE',
      offlineAck.payload?.status === 'failed' && offlineAck.payload?.reason === 'TARGET_OFFLINE',
      JSON.stringify(offlineAck),
    );

    /* ------------------------------------------------------------------ */
    section('Replay suppression (dedupe by sender + message id)');
    /* ------------------------------------------------------------------ */
    const dupId = `e2e-${Date.now()}-dupe`;
    const dupFrame = {
      v: 1,
      id: dupId,
      op: 'MESSAGE',
      type: 'e2e.chat.message',
      route: { mode: 'DIRECT', target: context.uuidB },
      payload: { seq: 1 },
    };
    a.send(dupFrame);
    await a.waitFor((frame) => frame.op === 'ACK' && frame.replyTo === dupId, { describe: 'first ACK accepted' });
    await a.waitFor((frame) => frame.op === 'ACK' && frame.replyTo === dupId, { describe: 'first ACK delivered' });
    await b.waitFor((frame) => frame.op === 'MESSAGE' && frame.id === dupId, { describe: 'first delivery' });

    a.send(dupFrame);
    const replayAck = await a.waitFor((frame) => frame.op === 'ACK' && frame.replyTo === dupId, {
      describe: 'replay ACK',
    });
    check(
      'identical replay is acknowledged without re-fan-out',
      replayAck.payload?.status === 'accepted' && replayAck.payload?.recipients === undefined,
      JSON.stringify(replayAck),
    );
    const bAfterReplay = await settle(b, 400);
    check(
      'recipient receives the replayed message exactly once',
      bAfterReplay.filter((frame) => frame.op === 'MESSAGE' && frame.id === dupId).length === 0,
      bAfterReplay.map((frame) => frame.op).join(','),
    );

    a.send({ ...dupFrame, payload: { seq: 2 } });
    const conflictingAck = await a.waitFor(
      (frame) => frame.op === 'ACK' && frame.replyTo === dupId && frame.payload?.status === 'failed',
      { describe: 'DUPLICATE_MESSAGE_ID ACK' },
    );
    check(
      'same id with a different payload -> ACK failed DUPLICATE_MESSAGE_ID',
      conflictingAck.payload?.reason === 'DUPLICATE_MESSAGE_ID',
      JSON.stringify(conflictingAck),
    );

    /* ------------------------------------------------------------------ */
    section('Envelope validation');
    /* ------------------------------------------------------------------ */
    const reservedId = `e2e-${Date.now()}-reserved`;
    a.send({
      v: 1,
      id: reservedId,
      op: 'MESSAGE',
      type: 'srp.ping',
      route: { mode: 'DIRECT', target: context.uuidB },
      payload: {},
    });
    const reservedError = await a.waitFor((frame) => frame.op === 'ERROR' && frame.replyTo === reservedId, {
      describe: 'INVALID_TYPE for a reserved namespace',
    });
    check(
      'reserved namespace (srp.*) -> ERROR INVALID_TYPE',
      reservedError.payload?.code === 'INVALID_TYPE',
      JSON.stringify(reservedError.payload),
    );

    const badTypeId = `e2e-${Date.now()}-badtype`;
    a.send({
      v: 1,
      id: badTypeId,
      op: 'MESSAGE',
      type: 'not a valid type!',
      route: { mode: 'DIRECT', target: context.uuidB },
      payload: {},
    });
    const badTypeError = await a.waitFor((frame) => frame.op === 'ERROR' && frame.replyTo === badTypeId, {
      describe: 'INVALID_TYPE for illegal characters',
    });
    check(
      'illegal characters in type -> ERROR INVALID_TYPE',
      badTypeError.payload?.code === 'INVALID_TYPE',
      JSON.stringify(badTypeError.payload),
    );

    const versionId = `e2e-${Date.now()}-v2`;
    a.send({
      v: 2,
      id: versionId,
      op: 'MESSAGE',
      type: 'e2e.chat.message',
      route: { mode: 'DIRECT', target: context.uuidB },
      payload: {},
    });
    const versionError = await a.waitFor(
      (frame) => frame.op === 'ERROR' && frame.payload?.code === 'UNSUPPORTED_VERSION',
      { describe: 'UNSUPPORTED_VERSION' },
    );
    check('v=2 envelope -> ERROR UNSUPPORTED_VERSION', versionError.payload?.code === 'UNSUPPORTED_VERSION');

    a.socket.send('this is not json');
    const jsonError = await a.waitFor((frame) => frame.op === 'ERROR' && frame.payload?.code === 'INVALID_ENVELOPE', {
      describe: 'INVALID_ENVELOPE',
    });
    check('non-JSON frame -> ERROR INVALID_ENVELOPE', jsonError.payload?.code === 'INVALID_ENVELOPE');

    // Over MAX_PAYLOAD_BYTES (64 KiB) but under MAX_FRAME_BYTES (128 KiB): the
    // payload budget must be enforced before routing, and the socket must survive.
    const oversizedId = `e2e-${Date.now()}-oversized`;
    a.send({
      v: 1,
      id: oversizedId,
      op: 'MESSAGE',
      type: 'e2e.chat.message',
      route: { mode: 'DIRECT', target: context.uuidB },
      payload: { blob: 'x'.repeat(70_000) },
    });
    const oversizedError = await a.waitFor(
      (frame) => frame.op === 'ERROR' && frame.replyTo === oversizedId,
      { describe: 'PAYLOAD_TOO_LARGE error', timeoutMs: 8000 },
    );
    check(
      'payload over MAX_PAYLOAD_BYTES -> ERROR PAYLOAD_TOO_LARGE',
      oversizedError.payload?.code === 'PAYLOAD_TOO_LARGE',
      JSON.stringify(oversizedError.payload),
    );
    const oversizedAck = await a.waitFor(
      (frame) => frame.op === 'ACK' && frame.replyTo === oversizedId,
      { describe: 'PAYLOAD_TOO_LARGE ACK', timeoutMs: 8000 },
    );
    check(
      'payload over MAX_PAYLOAD_BYTES -> ACK failed PAYLOAD_TOO_LARGE',
      oversizedAck.payload?.status === 'failed' && oversizedAck.payload?.reason === 'PAYLOAD_TOO_LARGE',
      JSON.stringify(oversizedAck.payload),
    );

    /* ------------------------------------------------------------------ */
    section('PING / PONG keepalive');
    /* ------------------------------------------------------------------ */
    const pingId = `e2e-${Date.now()}-ping`;
    a.send({ v: 1, id: pingId, op: 'PING' });
    const pong = await a.waitFor((frame) => frame.op === 'PONG', { describe: 'PONG' });
    check('PING -> PONG with replyTo', pong.replyTo === pingId, JSON.stringify(pong));

    /* ------------------------------------------------------------------ */
    section('Rate limiting');
    /* ------------------------------------------------------------------ */
    const burst = 60; // burst limit is 40 tokens/s by default, rate 20/s
    for (let index = 0; index < burst; index += 1) {
      a.send({
        v: 1,
        id: `e2e-${Date.now()}-rate-${index}`,
        op: 'MESSAGE',
        type: 'e2e.chat.message',
        route: { mode: 'DIRECT', target: '00000000-0000-4000-8000-000000000000' },
        payload: { index },
      });
    }
    const rateLimited = await a.waitFor((frame) => frame.op === 'ERROR' && frame.payload?.code === 'RATE_LIMITED', {
      describe: 'RATE_LIMITED error',
      timeoutMs: 10_000,
    });
    check('burst over the token bucket -> ERROR RATE_LIMITED', rateLimited.payload?.code === 'RATE_LIMITED');
    const rateAck = await a.waitFor(
      (frame) => frame.op === 'ACK' && frame.payload?.status === 'failed' && frame.payload?.reason === 'RATE_LIMITED',
      { describe: 'ACK failed RATE_LIMITED', timeoutMs: 10_000 },
    );
    check('rate-limited message also gets ACK failed RATE_LIMITED', rateAck.payload?.reason === 'RATE_LIMITED');

    await sleep(300);
    const pingAfterLimit = `e2e-${Date.now()}-ping2`;
    a.send({ v: 1, id: pingAfterLimit, op: 'PING' });
    const pongAfterLimit = await a.waitFor((frame) => frame.op === 'PONG' && frame.replyTo === pingAfterLimit, {
      describe: 'PONG after rate limit',
      timeoutMs: 8000,
    });
    check('rate limiting does not close the connection', pongAfterLimit.replyTo === pingAfterLimit);

    /* ------------------------------------------------------------------ */
    section('Upgrade rejection (HTTP status before any frame)');
    /* ------------------------------------------------------------------ */
    checkUpgradeRejected('no Authorization header -> 401 UNAUTHORIZED', await probeUpgrade({ url: WS_URL }), 401, 'UNAUTHORIZED');

    const forged =
      'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.' +
      Buffer.from(JSON.stringify({ sub: 'forged', sid: 'forged', minecraft_uuid: context.uuidB, scope: 'skymatrix:ircserver' }))
        .toString('base64url') +
      '.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    checkUpgradeRejected('forged signature -> 401 UNAUTHORIZED', await probeUpgrade({ url: WS_URL, token: forged }), 401, 'UNAUTHORIZED');

    if (context.tokenExpired) {
      checkUpgradeRejected(
        'expired token -> 401 TOKEN_EXPIRED',
        await probeUpgrade({ url: WS_URL, token: context.tokenExpired }),
        401,
        'TOKEN_EXPIRED',
      );
    } else {
      skip('expired token -> 401 TOKEN_EXPIRED', 'no IRC_TEST_TOKEN_EXPIRED supplied in external mode');
    }

    if (context.tokenNoScope) {
      checkUpgradeRejected(
        'token without skymatrix:ircserver -> 403 SCOPE_DENIED',
        await probeUpgrade({ url: WS_URL, token: context.tokenNoScope }),
        403,
        'SCOPE_DENIED',
      );
    } else {
      skip('token without skymatrix:ircserver -> 403 SCOPE_DENIED', 'no IRC_TEST_TOKEN_NO_SCOPE supplied');
    }

    checkUpgradeRejected(
      'unknown upgrade path -> 404 NOT_FOUND',
      await probeUpgrade({ url: WS_URL.replace('/v1/connect', '/v2/connect'), token: context.tokenA }),
      404,
      'NOT_FOUND',
    );

    /* ------------------------------------------------------------------ */
    section('Session revocation (shared Redis key)');
    /* ------------------------------------------------------------------ */
    const sessionId = context.claimsA?.sid;
    if (!sessionId) {
      skip('revoked session -> 403 SESSION_REVOKED', 'token has no sid claim');
    } else {
      redis = await loadRedisClient();
      const key = `auth:session:revoked:${sessionId}`;
      await redis.set(key, '1', 'EX', 60);
      try {
        checkUpgradeRejected(
          'revoked session -> 403 SESSION_REVOKED',
          await probeUpgrade({ url: WS_URL, token: context.tokenA }),
          403,
          'SESSION_REVOKED',
        );
        const stillOpen = a.isOpen;
        check('revocation applies to new upgrades, not to sockets already open', stillOpen);
      } finally {
        await redis.del(key);
      }
      const restored = await probeUpgrade({ url: WS_URL, token: context.tokenA });
      check('after un-revoking, the same token upgrades again (101)', restored.status === 101, `HTTP ${restored.status}`);
    }

    /* ------------------------------------------------------------------ */
    section('Graceful shutdown');
    /* ------------------------------------------------------------------ */
    if (stack && process.platform !== 'win32') {
      const irc = stack.processes.find((service) => service.label === 'irc-server');
      const closed = new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 8000);
        a.socket.addEventListener('close', (event) => {
          clearTimeout(timer);
          resolve(event.code);
        });
      });
      irc.child.kill('SIGTERM');
      const code = await closed;
      check('SIGTERM closes open sockets with code 1001', code === 1001, `close code ${code}`);
    } else if (process.platform === 'win32') {
      skip('SIGTERM graceful shutdown', 'Node cannot deliver POSIX signals on Windows');
    } else {
      skip('SIGTERM graceful shutdown', 'external mode: the harness does not own the server process');
    }
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    if (redis) await redis.quit().catch(() => {});
    if (stack) await stack.close().catch(() => {});
  }

  /* -------------------------------------------------------------------- */
  console.log(
    `\n${failures === 0 ? 'RESULT: PASS' : 'RESULT: FAIL'} — ${checks - failures}/${checks} checks passed, ${skipped} skipped ` +
      `(${Date.now() - startedAt} ms wall clock, mode=${EXTERNAL ? 'external' : 'managed'})`,
  );
  if (failures > 0) console.log('Failures above are real: the server did not behave as documented.');
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(`\n[fatal] ${error?.stack ?? error?.message ?? error}`);
  console.error('The harness could not run. No PASS was observed, so this is not a passing run.');
  process.exitCode = 2;
});
