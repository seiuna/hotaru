/**
 * End-to-end smoke test for the MC Auth Platform.
 *
 * It starts the fake Mojang session server, boots the real auth-server against a
 * throwaway Mongo database and the local Redis, then walks the whole user story
 * with a client written independently of the server code:
 *
 *   challenge -> (RSA handshake) -> Mojang join -> verify -> JWT
 *   -> /users/me -> refresh -> reuse detection -> admin grant -> ban -> 403
 *
 * Run: node tools/e2e/smoke.mjs
 * Exit code 0 = every assertion passed.
 */
import { spawn } from 'node:child_process';
import { constants, createHash, createPublicKey, publicEncrypt, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { startFakeMojang } from './fake-mojang.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const AUTH_PORT = Number(process.env.E2E_AUTH_PORT ?? 3100);
const MOJANG_PORT = Number(process.env.E2E_MOJANG_PORT ?? 8787);
const RUN_ID = `${Date.now()}`;
const DB = `hotaru_e2e_${RUN_ID}`;
const BASE = `http://127.0.0.1:${AUTH_PORT}`;
/**
 * Each run presents its own client IP through X-Forwarded-For (the app trusts
 * the proxy). Rate-limit counters live in the shared Redis instance and survive
 * between runs, so without this a previous run's burst would 429 this one.
 */
const RUN_IP = `10.${(Date.now() >> 8) % 250}.${Date.now() % 250}.7`;

let failures = 0;
let checks = 0;

function check(name, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

async function api(method, route, { body, token, headers } = {}) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'x-forwarded-for': RUN_IP,
      ...(headers ?? {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, headers: res.headers };
}

/** Independent implementation of the vanilla server hash (spec-derived, not imported). */
function minecraftServerHash(serverId, sharedSecret, publicKeyDer) {
  const digest = createHash('sha1')
    .update(Buffer.from(serverId, 'ascii'))
    .update(sharedSecret)
    .update(publicKeyDer)
    .digest();
  let value = BigInt(`0x${digest.toString('hex')}`);
  const limit = 1n << 160n;
  if (value >= limit / 2n) value -= limit;
  return value.toString(16);
}

const hexUuid = (seed) => createHash('md5').update(seed).digest('hex');
const dashedUuid = (hex) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

/** Full client-side handshake: challenge -> RSA -> Mojang join -> verify. */
async function handshake({ username, uuidHex, mojangBase, expectFail = false }) {
  const challenge = await api('POST', '/api/v1/auth/minecraft/challenge', {
    body: { username, client: 'fabric' },
  });
  if (challenge.status !== 200) {
    if (expectFail) return challenge;
    throw new Error(`challenge failed: ${challenge.status} ${JSON.stringify(challenge.json)}`);
  }

  const publicKeyDer = Buffer.from(challenge.json.publicKey, 'base64');
  const publicKey = createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
  const sharedSecret = randomBytes(16);
  const hash = minecraftServerHash(challenge.json.serverId, sharedSecret, publicKeyDer);

  const joinResponse = await fetch(`${mojangBase}/session/minecraft/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      accessToken: `${uuidHex}.${username}`,
      selectedProfile: uuidHex,
      serverId: hash,
    }),
  });
  if (joinResponse.status !== 204) throw new Error(`mojang join failed: ${joinResponse.status}`);

  const encrypt = (buffer) =>
    publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, buffer).toString('base64');

  const verify = await api('POST', '/api/v1/auth/minecraft/verify', {
    body: {
      challengeId: challenge.json.challengeId,
      username,
      encryptedSharedSecret: encrypt(sharedSecret),
      encryptedVerifyToken: encrypt(Buffer.from(challenge.json.verifyToken, 'base64')),
    },
  });

  return { status: verify.status, json: verify.json, challenge, hash };
}

function authServerEnv(mojangBase) {
  return {
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: String(AUTH_PORT),
    LOG_LEVEL: 'warn',
    MONGODB_URI: process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017',
    MONGODB_DB: DB,
    REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:16379',
    PUBLIC_BASE_URL: BASE,
    JWT_AUDIENCE: 'hotaru-api',
    CHALLENGE_TTL_SECONDS: '60',
    RATE_LIMIT_CHALLENGE_MAX: '100',
    RATE_LIMIT_VERIFY_MAX: '100',
    MOJANG_SESSION_SERVER: mojangBase,
    MOJANG_HAS_JOINED_ATTEMPTS: '1',
    MOJANG_RETRY_DELAY_MS: '50',
    DEFAULT_SCOPES: 'hotaru:profile',
  };
}

async function startAuthServer(mojangBase) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/server.ts'],
    {
      cwd: path.join(repoRoot, 'apps', 'auth-server'),
      env: authServerEnv(mojangBase),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));

  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/v1/health/ready`);
      if (res.ok) return { child, logs };
    } catch {
      /* not up yet */
    }
    if (child.exitCode !== null) {
      throw new Error(`auth-server exited early (${child.exitCode}):\n${logs.join('')}`);
    }
    await sleep(400);
  }
  throw new Error(`auth-server never became ready:\n${logs.join('')}`);
}

async function runSeedAdmin(uuid) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'scripts/seed-admin.ts', '--uuid', uuid, '--username', 'AdminUser'],
      { cwd: path.join(repoRoot, 'apps', 'auth-server'), env: authServerEnv('http://127.0.0.1:1'), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (out += String(d)));
    child.on('exit', (code) => resolve({ code, out }));
  });
}

async function main() {
  const mojang = startFakeMojang({ port: MOJANG_PORT, log: () => {} });
  const mojangBase = await mojang.listen();
  console.log(`fake Mojang listening on ${mojangBase}; db=${DB}`);

  let server;
  try {
    server = await startAuthServer(mojangBase);
    console.log(`auth-server ready on ${BASE}`);

    const aliceUuid = hexUuid(`alice-${RUN_ID}`);
    const malloryUuid = hexUuid(`mallory-${RUN_ID}`);

    section('health');
    const live = await api('GET', '/api/v1/health/live');
    check('GET /health/live is 200 ok', live.status === 200 && live.json?.status === 'ok', JSON.stringify(live.json));
    const ready = await api('GET', '/api/v1/health/ready');
    check('GET /health/ready reports mongo+redis ok', ready.status === 200 && ready.json?.checks?.mongo === 'ok', JSON.stringify(ready.json));

    section('jwks');
    const jwks = await api('GET', '/api/v1/auth/jwks');
    check('jwks exposes a single Ed25519 key', jwks.status === 200 && jwks.json?.keys?.[0]?.kty === 'OKP', JSON.stringify(jwks.json));
    check('jwks key declares EdDSA', jwks.json?.keys?.[0]?.alg === 'EdDSA', JSON.stringify(jwks.json?.keys?.[0]));

    section('challenge');
    const ch = await api('POST', '/api/v1/auth/minecraft/challenge', { body: { username: 'Alice' } });
    check('challenge returns 200', ch.status === 200, JSON.stringify(ch.json));
    check('challenge has id/serverId/publicKey/verifyToken', Boolean(ch.json?.challengeId && ch.json?.serverId && ch.json?.publicKey && ch.json?.verifyToken));
    check('challenge ttl is 60s', ch.json?.expiresIn === 60, String(ch.json?.expiresIn));

    section('negative: verify without a Mojang join');
    const bare = await api('POST', '/api/v1/auth/minecraft/verify', {
      body: {
        challengeId: ch.json.challengeId,
        username: 'Alice',
        encryptedSharedSecret: 'AAAA',
        encryptedVerifyToken: 'BBBB',
      },
    });
    check('garbage ciphertext is rejected as INVALID_REQUEST', bare.status === 400 && bare.json?.error?.code === 'INVALID_REQUEST', JSON.stringify(bare.json));

    section('negative: unknown challenge');
    const unknown = await api('POST', '/api/v1/auth/minecraft/verify', {
      body: { challengeId: '00000000-0000-4000-8000-000000000000', username: 'Alice', encryptedSharedSecret: 'AAAA', encryptedVerifyToken: 'BBBB' },
    });
    check('unknown challenge id -> CHALLENGE_NOT_FOUND', unknown.status === 404 && unknown.json?.error?.code === 'CHALLENGE_NOT_FOUND', JSON.stringify(unknown.json));

    section('happy path: premium login');
    const login = await handshake({ username: 'Alice', uuidHex: aliceUuid, mojangBase });
    check('verify returns 200', login.status === 200, JSON.stringify(login.json));
    check('profile uuid matches Mojang identity', login.json?.profile?.uuid === dashedUuid(aliceUuid), `${login.json?.profile?.uuid} vs ${dashedUuid(aliceUuid)}`);
    check('profile username matches', login.json?.profile?.username === 'Alice', login.json?.profile?.username);
    check('default scopes granted', Array.isArray(login.json?.scopes) && login.json.scopes.includes('hotaru:profile'), JSON.stringify(login.json?.scopes));
    check('token type is Bearer', login.json?.tokenType === 'Bearer');
    check('access token is an EdDSA JWT', String(login.json?.accessToken).startsWith('eyJ'));

    const access = login.json.accessToken;
    const refresh = login.json.refreshToken;

    section('replay: a consumed challenge cannot be reused');
    const replay = await api('POST', '/api/v1/auth/minecraft/verify', {
      body: { challengeId: login.challenge.json.challengeId, username: 'Alice', encryptedSharedSecret: 'AAAA', encryptedVerifyToken: 'BBBB' },
    });
    check('second verify on same challenge -> CHALLENGE_CONSUMED', replay.status === 409 && replay.json?.error?.code === 'CHALLENGE_CONSUMED', JSON.stringify(replay.json));

    section('identity: one challenge cannot authenticate another player');
    const crossCh = await api('POST', '/api/v1/auth/minecraft/challenge', { body: { username: 'Alice' } });
    check('challenge for Alice issued', crossCh.status === 200);
    const stolen = await api('POST', '/api/v1/auth/minecraft/verify', {
      body: { challengeId: crossCh.json.challengeId, username: 'Mallory', encryptedSharedSecret: 'AAAA', encryptedVerifyToken: 'BBBB' },
    });
    check('verify with a different username is rejected', stolen.status === 400, JSON.stringify(stolen.json));

    section('authenticated endpoints');
    const me = await api('GET', '/api/v1/users/me', { token: access });
    check('GET /users/me returns the caller', me.status === 200 && me.json?.user?.minecraftUuid === dashedUuid(aliceUuid), JSON.stringify(me.json));
    const perms = await api('GET', '/api/v1/users/me/permissions', { token: access });
    check('GET /users/me/permissions lists scopes', perms.status === 200 && perms.json?.scopes?.includes('hotaru:profile'), JSON.stringify(perms.json));
    const noToken = await api('GET', '/api/v1/users/me');
    check('missing bearer token -> 401', noToken.status === 401 && noToken.json?.error?.code === 'UNAUTHORIZED', JSON.stringify(noToken.json));
    const badToken = await api('GET', '/api/v1/users/me', { token: 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJmYWtlIn0.signature' });
    check('forged JWT -> 401', badToken.status === 401, JSON.stringify(badToken.json));

    section('refresh rotation');
    const refreshed = await api('POST', '/api/v1/auth/refresh', { body: { refreshToken: refresh } });
    check('refresh returns a new token pair', refreshed.status === 200 && refreshed.json?.accessToken && refreshed.json?.refreshToken, JSON.stringify(refreshed.json));
    check('refresh rotates the refresh token', refreshed.json?.refreshToken !== refresh);
    const reuse = await api('POST', '/api/v1/auth/refresh', { body: { refreshToken: refresh } });
    check('reusing the old refresh token -> REFRESH_REUSED', reuse.status === 401 && reuse.json?.error?.code === 'REFRESH_REUSED', JSON.stringify(reuse.json));
    const afterRevoke = await api('GET', '/api/v1/users/me', { token: refreshed.json.accessToken });
    check('session revoked by reuse detection -> 401', afterRevoke.status === 401, JSON.stringify(afterRevoke.json));

    // Reuse detection revoked Alice's whole session, so obtain a fresh one for the
    // remaining checks. This also covers "logging in again after refresh abuse".
    const relogin = await handshake({ username: 'Alice', uuidHex: aliceUuid, mojangBase });
    check('user can log in again after refresh reuse', relogin.status === 200, JSON.stringify(relogin.json));
    const access2 = relogin.json.accessToken;

    section('admin: seed, scope enforcement, grant, ban');
    const seeded = await runSeedAdmin(dashedUuid(malloryUuid));
    check('admin seed script exits 0', seeded.code === 0, seeded.out.slice(0, 300));

    const adminLogin = await handshake({ username: 'Mallory', uuidHex: malloryUuid, mojangBase });
    check('admin login succeeds', adminLogin.status === 200, JSON.stringify(adminLogin.json));
    check('admin has admin:users scope', adminLogin.json?.scopes?.includes('admin:users'), JSON.stringify(adminLogin.json?.scopes));

    const adminToken = adminLogin.json.accessToken;
    const listed = await api('GET', '/api/v1/admin/users?limit=10', { token: adminToken });
    check('GET /admin/users works for admin', listed.status === 200 && Array.isArray(listed.json?.users), JSON.stringify(listed.json));
    const notAdmin = await api('GET', '/api/v1/admin/users', { token: access2 });
    check('non-admin JWT -> 403 FORBIDDEN', notAdmin.status === 403 && notAdmin.json?.error?.code === 'FORBIDDEN', JSON.stringify(notAdmin.json));

    const aliceId = (await api('GET', '/api/v1/users/me', { token: access2 })).json.user.id;
    const grant = await api('PUT', `/api/v1/admin/users/${aliceId}/permissions`, {
      token: adminToken,
      body: { permissions: [{ scope: 'hotaru:profile' }, { scope: 'hotaru:resource' }] },
    });
    check('admin grants hotaru:resource', grant.status === 200, JSON.stringify(grant.json));
    const meAfterGrant = await api('GET', '/api/v1/users/me', { token: access2 });
    check('grant takes effect for an existing JWT', meAfterGrant.json?.scopes?.includes('hotaru:resource'), JSON.stringify(meAfterGrant.json?.scopes));

    const revokeGrant = await api('PUT', `/api/v1/admin/users/${aliceId}/permissions`, {
      token: adminToken,
      body: { permissions: [{ scope: 'hotaru:profile' }] },
    });
    check('admin revokes hotaru:resource', revokeGrant.status === 200);
    const meAfterRevoke = await api('GET', '/api/v1/users/me', { token: access2 });
    check('revocation takes effect immediately', !meAfterRevoke.json?.scopes?.includes('hotaru:resource'), JSON.stringify(meAfterRevoke.json?.scopes));

    section('ban');
    const banned = await api('POST', `/api/v1/admin/users/${aliceId}/ban`, { token: adminToken, body: { reason: 'e2e' } });
    check('admin bans the user', banned.status === 200, JSON.stringify(banned.json));
    // Ban revokes sessions, so an existing token may report either the ban (403)
    // or the revoked session (401). Both are a refusal; neither may return data.
    const bannedMe = await api('GET', '/api/v1/users/me', { token: access2 });
    check(
      'existing JWT stops working after ban (401 SESSION_REVOKED or 403 USER_BANNED)',
      bannedMe.status === 401 || (bannedMe.status === 403 && bannedMe.json?.error?.code === 'USER_BANNED'),
      `${bannedMe.status} ${JSON.stringify(bannedMe.json)}`,
    );
    check('banned user gets no profile data', bannedMe.json?.user === undefined);
    const bannedLogin = await handshake({ username: 'Alice', uuidHex: aliceUuid, mojangBase });
    check('banned user cannot log in again (403 USER_BANNED)', bannedLogin.status === 403 && bannedLogin.json?.error?.code === 'USER_BANNED', JSON.stringify(bannedLogin.json));
    const unbanned = await api('POST', `/api/v1/admin/users/${aliceId}/unban`, { token: adminToken });
    check('admin unbans the user', unbanned.status === 200, JSON.stringify(unbanned.json));
    const afterUnban = await handshake({ username: 'Alice', uuidHex: aliceUuid, mojangBase });
    check('unbanned user can log in again', afterUnban.status === 200, JSON.stringify(afterUnban.json));

    section('Mojang outage fails closed');
    mojang.setOutage(true);
    const outage = await handshake({ username: 'Alice', uuidHex: aliceUuid, mojangBase, expectFail: true });
    mojang.setOutage(false);
    check('Mojang 5xx -> 503 MOJANG_UNAVAILABLE', outage.status === 503 && outage.json?.error?.code === 'MOJANG_UNAVAILABLE', JSON.stringify(outage.json));
    check('no access token issued during outage', outage.json?.accessToken === undefined);

    section('rate limiting');
    const burst = [];
    for (let i = 0; i < 130; i++) {
      burst.push(api('POST', '/api/v1/auth/minecraft/challenge', { body: { username: 'SpamUser' } }));
    }
    const results = await Promise.all(burst);
    check('burst is throttled with 429', results.some((r) => r.status === 429), `statuses=${[...new Set(results.map((r) => r.status))].join(',')}`);

    section('audit log');
    const audit = await api('GET', '/api/v1/admin/audit-logs?limit=50', { token: adminToken });
    check('audit log records admin actions', audit.status === 200 && Array.isArray(audit.json?.logs) && audit.json.logs.length > 0, JSON.stringify(audit.json).slice(0, 200));
    check('audit log is paginated newest-first', typeof audit.json?.total === 'number' && Array.isArray(audit.json?.logs), JSON.stringify(audit.json?.total));
  } finally {
    if (server) {
      server.child.kill('SIGTERM');
      await sleep(800);
      if (server.child.exitCode === null) server.child.kill('SIGKILL');
    }
    await mojang.close();
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    console.log(`${failures} FAILED`);
    process.exitCode = 1;
  } else {
    console.log('E2E OK');
  }
}

main().catch((error) => {
  console.error('\nE2E crashed:', error);
  process.exitCode = 1;
});
