/**
 * Real-credential login test for the MC Auth Platform.
 *
 * Unlike tools/e2e/smoke.mjs (which fakes Mojang), this drives the REAL Mojang
 * session server with a REAL Minecraft access token, so it proves the live
 * join/hasJoined handshake end to end.
 *
 * Credentials are read from the environment or from apps/auth-server/.env:
 *
 *   MC_ACCESS_TOKEN   the Minecraft access token (from the launcher session)
 *   MC_UUID           the account UUID, dashed or undashed
 *   MC_USERNAME       the current Minecraft username
 *
 * Usage:
 *   node tools/e2e/real-login.mjs                # uses the real Mojang server
 *   node tools/e2e/real-login.mjs --fake         # self-test, no credentials needed
 *
 * Safety properties:
 *   * the access token is never printed, never logged, and never sent to the
 *     auth server — only to Mojang, exactly as the game client does;
 *   * a throwaway database is used, so no real data is touched;
 *   * the access token is shown only as a SHA-256 fingerprint prefix.
 */
import { spawn } from 'node:child_process';
import { createHash, createPublicKey, constants, generateKeyPairSync, publicEncrypt, randomBytes, verify as verifySignature } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { startFakeMojang } from './fake-mojang.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const APP_DIR = path.join(repoRoot, 'apps', 'auth-server');
const FAKE = process.argv.includes('--fake');
const PORT = Number(process.env.REAL_PORT ?? 3105);
const MOJANG_PORT = 8788;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = `hotaru_real_${Date.now()}`;

let failures = 0;
let checks = 0;
const check = (name, cond, detail = '') => {
  checks += 1;
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`);
  }
};

/** Minimal .env reader so this script needs no dependency. */
function loadEnvFile(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const envFile = {
  ...loadEnvFile(path.join(APP_DIR, '.env')),
  ...loadEnvFile(path.join(here, '.env.real')),
};
const get = (key) => process.env[key] ?? envFile[key] ?? '';
const fingerprint = (value) => createHash('sha256').update(value).digest('hex').slice(0, 10);

/** Vanilla server hash: sha1(serverId ASCII || secret || DER) as signed 160-bit hex. */
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

const dashed = (uuid) => {
  const hex = uuid.replace(/-/g, '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

async function api(method, route, { body, token } = {}) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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
  return { status: res.status, json };
}

function serverEnv(mojangBase) {
  return {
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: String(PORT),
    LOG_LEVEL: 'warn',
    MONGODB_URI: get('MONGODB_URI') || 'mongodb://127.0.0.1:27017',
    MONGODB_DB: DB,
    REDIS_URL: get('REDIS_URL') || 'redis://127.0.0.1:16379',
    PUBLIC_BASE_URL: BASE,
    JWT_AUDIENCE: 'hotaru-api',
    CHALLENGE_TTL_SECONDS: '120',
    RATE_LIMIT_CHALLENGE_MAX: '50',
    RATE_LIMIT_VERIFY_MAX: '50',
    MOJANG_SESSION_SERVER: mojangBase,
    MOJANG_HAS_JOINED_ATTEMPTS: '3',
    MOJANG_RETRY_DELAY_MS: '800',
    DEFAULT_SCOPES: 'hotaru:profile',
  };
}

async function startServer(mojangBase) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: APP_DIR,
    env: serverEnv(mojangBase),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
    if (child.exitCode !== null) throw new Error(`server exited early:\n${logs.join('')}`);
    await sleep(400);
  }
  throw new Error(`server never became ready:\n${logs.join('')}`);
}

function printMissingTokenHelp() {
  console.log(
    [
      '',
      'No Minecraft access token found.',
      '',
      'Add ONE line to apps/auth-server/.env (that file is git-ignored):',
      '',
      '  TEST_ACCESSTOKEN=<your Minecraft access token>',
      '',
      '(MC_ACCESS_TOKEN is accepted as an alternative name.)',
      '',
      'The UUID and username are resolved automatically from the token via',
      'api.minecraftservices.com/minecraft/profile, so you do not need to look them up.',
      'Optionally override with MC_UUID / MC_USERNAME (or put them in tools/e2e/.env.real).',
      '',
      'Where the token comes from:',
      '  * it is the session token your launcher holds, not a Microsoft password;',
      '  * read it from the launcher session of an account you own and treat it like a password;',
      '  * tokens expire — restart the game/launcher and copy a fresh one if join returns 403.',
      '',
      'Then re-run:  node tools/e2e/real-login.mjs',
      '',
    ].join('\n'),
  );
}

/**
 * Resolves { uuid, username } from an access token via Mojang's own profile
 * endpoint, so a tester only has to supply the token.
 */
async function resolveProfile(accessToken) {
  const res = await fetch('https://api.minecraftservices.com/minecraft/profile', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401 || res.status === 403) {
    return { error: 'the access token is invalid, expired, or not accepted by Mojang (HTTP ' + res.status + ')' };
  }
  if (!res.ok) return { error: `profile lookup failed (HTTP ${res.status})` };
  const body = await res.json().catch(() => null);
  if (!body?.id || !body?.name) return { error: 'profile endpoint returned no id/name' };
  return { uuid: String(body.id), username: String(body.name) };
}

async function main() {
  let accessToken;
  let uuid;
  let username;
  let mojangBase;
  let fake = null;

  if (FAKE) {
    fake = startFakeMojang({ port: 0, log: () => {} });
    mojangBase = await fake.listen();
    const hex = randomBytes(16).toString('hex');
    uuid = hex;
    username = 'SelfTestPlayer';
    accessToken = `${hex}.${username}`;
    console.log('SELF-TEST mode: local fake Mojang, synthetic credentials\n');
  } else {
    accessToken = get('TEST_ACCESSTOKEN') || get('MC_ACCESS_TOKEN');
    uuid = (get('MC_UUID') || '').replace(/-/g, '').toLowerCase();
    username = get('MC_USERNAME');
    if (!accessToken) {
      printMissingTokenHelp();
      process.exitCode = 2;
      return;
    }
    if (!uuid || !username) {
      console.log('resolving UUID + username from the token ...');
      const resolved = await resolveProfile(accessToken);
      if (resolved.error) {
        console.log(`  FAIL  ${resolved.error}`);
        console.log('\nNothing was sent to our server. Get a fresh token and retry.');
        process.exitCode = 1;
        return;
      }
      uuid = resolved.uuid.replace(/-/g, '').toLowerCase();
      username = resolved.username;
      console.log(`  resolved ${username} / ${dashed(uuid)}`);
    }
    mojangBase = 'https://sessionserver.mojang.com';
  }

  console.log(`account: ${username}  uuid=${dashed(uuid)}  token-sha256=${fingerprint(accessToken)}`);
  console.log(`mojang:  ${mojangBase}`);
  console.log(`db:      ${DB}\n`);

  let server;
  try {
    server = await startServer(mojangBase);
    console.log('auth-server ready\n');

    console.log('== 1. challenge ==');
    const challenge = await api('POST', '/api/v1/auth/minecraft/challenge', {
      body: { username, client: 'fabric' },
    });
    check('challenge issued', challenge.status === 200, JSON.stringify(challenge.json));
    if (challenge.status !== 200) throw new Error('challenge failed');

    const publicKeyDer = Buffer.from(challenge.json.publicKey, 'base64');
    const publicKey = createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
    const sharedSecret = randomBytes(16);
    const serverHash = minecraftServerHash(challenge.json.serverId, sharedSecret, publicKeyDer);

    console.log('\n== 2. Mojang join (real handshake) ==');
    const joinRes = await fetch(`${mojangBase}/session/minecraft/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken, selectedProfile: uuid, serverId: serverHash }),
    });
    if (joinRes.status === 403) {
      console.log('  FAIL  Mojang rejected the access token (403 Invalid token / expired)');
      failures += 1;
      console.log('\nThe token is expired or was revoked. Restart the game/launcher and copy a fresh token.');
      return;
    }
    if (joinRes.status === 204) {
      check('Mojang accepted the join (204)', true);
    } else {
      const body = await joinRes.text();
      check('Mojang accepted the join (204)', false, `${joinRes.status} ${body.slice(0, 200)}`);
      return;
    }

    console.log('\n== 3. verify against our server ==');
    const encrypt = (buf) =>
      publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, buf).toString('base64');
    const verified = await api('POST', '/api/v1/auth/minecraft/verify', {
      body: {
        challengeId: challenge.json.challengeId,
        username,
        encryptedSharedSecret: encrypt(sharedSecret),
        encryptedVerifyToken: encrypt(Buffer.from(challenge.json.verifyToken, 'base64')),
      },
    });
    check('verify returns a token pair', verified.status === 200, JSON.stringify(verified.json));
    if (verified.status !== 200) return;

    check(
      'UUID returned by Mojang matches the account',
      verified.json.profile?.uuid === dashed(uuid),
      `${verified.json.profile?.uuid} vs ${dashed(uuid)}`,
    );
    check('profile username matches', verified.json.profile?.username?.toLowerCase() === username.toLowerCase(), verified.json.profile?.username);
    check('access token is a JWT', String(verified.json.accessToken).startsWith('eyJ'));

    console.log('\n== 4. independent JWT verification via JWKS ==');
    const jwks = await api('GET', '/api/v1/auth/jwks');
    const jwk = jwks.json?.keys?.[0];
    check('jwks published', Boolean(jwk?.kty === 'OKP'));
    if (jwk) {
      const [h, p, s] = verified.json.accessToken.split('.');
      const key = createPublicKey({ key: jwk, format: 'jwk' });
      const signatureOk = verifySignature(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
      check('JWT signature verifies with the published JWKS key', signatureOk);
      const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
      check('claims carry the Mojang UUID', claims.minecraft_uuid === dashed(uuid), claims.minecraft_uuid);
      check('claims carry a session id', typeof claims.sid === 'string' && claims.sid.length > 0);
      check('audience is the configured one', JSON.stringify(claims.aud).includes('hotaru-api'));
      console.log(`  info  sub=${claims.sub} scope="${claims.scope}" ttl=${claims.exp - claims.iat}s`);
    }

    console.log('\n== 5. authenticated call + refresh ==');
    const me = await api('GET', '/api/v1/users/me', { token: verified.json.accessToken });
    check('GET /users/me works with the issued JWT', me.status === 200 && me.json?.user?.minecraftUuid === dashed(uuid), JSON.stringify(me.json));
    const refreshed = await api('POST', '/api/v1/auth/refresh', { body: { refreshToken: verified.json.refreshToken } });
    check('refresh rotates the token pair', refreshed.status === 200 && Boolean(refreshed.json?.accessToken), JSON.stringify(refreshed.json));
    const reuse = await api('POST', '/api/v1/auth/refresh', { body: { refreshToken: verified.json.refreshToken } });
    check('replayed refresh token is rejected', reuse.status === 401 && reuse.json?.error?.code === 'REFRESH_REUSED', JSON.stringify(reuse.json));
  } finally {
    if (server) {
      server.child.kill('SIGTERM');
      await sleep(600);
      if (server.child.exitCode === null) server.child.kill('SIGKILL');
    }
    if (fake) await fake.close();
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    console.log(`${failures} FAILED`);
    process.exitCode = 1;
  } else {
    console.log(FAKE ? 'SELF-TEST OK (harness works; real credentials still unproven)' : 'REAL LOGIN OK');
  }
}

main().catch((error) => {
  console.error('\nFAILED:', error.message);
  process.exitCode = 1;
});
