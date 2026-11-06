/**
 * A disposable SRP v1 stack for the IRC end-to-end harness.
 *
 * Managed mode boots everything the protocol needs on loopback with throwaway
 * databases, exactly the way tools/e2e/smoke.mjs boots the auth server:
 *
 *   fake Mojang :ephemeral   (tools/e2e/fake-mojang.mjs, strict hasJoined)
 *   auth #1      :3200      DEFAULT_SCOPES = profile + skymatrix:ircserver
 *   auth #2      :3202      DEFAULT_SCOPES = profile only   (scope test)
 *   auth #3      :3203      ACCESS_TOKEN_TTL_SECONDS = 1    (expiry test)
 *   irc-server   :3201      SRP v1 WebSocket + REST
 *
 * The three auth servers share one MongoDB database, so they share the Ed25519
 * signing key and every token they mint is verifiable by the IRC server. They
 * also share `JWT_ISSUER` (the *public* issuer is #1) — the IRC server checks
 * `iss`, so a second instance must not invent its own identity.
 *
 * Nothing here is faked on the IRC side: the harness only ever speaks real HTTP
 * and real WebSocket frames to the real server process.
 */
import { spawn } from 'node:child_process';
import { constants, createHash, createPublicKey, publicEncrypt, randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { startFakeMojang } from '../fake-mojang.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..', '..', '..');

export const DEFAULTS = {
  mongoUri: process.env.E2E_IRC_MONGO_URI ?? process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017',
  redisUrl: process.env.E2E_IRC_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:16379',
  authPort: Number(process.env.E2E_IRC_AUTH_PORT ?? 3200),
  restrictedAuthPort: Number(process.env.E2E_IRC_AUTH_RESTRICTED_PORT ?? 3202),
  expiredAuthPort: Number(process.env.E2E_IRC_AUTH_EXPIRED_PORT ?? 3203),
  ircPort: Number(process.env.E2E_IRC_PORT ?? 3201),
};

/** Fast, non-fatal check that a TCP port accepts connections. */
export function probeTcp(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** Throws a message that tells the operator exactly what to start. */
export async function requireLocalInfra(mongoUri, redisUrl) {
  const mongo = new URL(mongoUri);
  const redis = new URL(redisUrl);
  const mongoPort = Number(mongo.port || 27017);
  const redisPort = Number(redis.port || 6379);
  const mongoOk = await probeTcp(mongo.hostname, mongoPort);
  const redisOk = await probeTcp(redis.hostname, redisPort);
  const missing = [];
  if (!mongoOk) missing.push(`MongoDB ${mongo.hostname}:${mongoPort}`);
  if (!redisOk) missing.push(`Redis ${redis.hostname}:${redisPort}`);
  if (missing.length > 0) {
    throw new Error(
      `local infrastructure is not running: ${missing.join(', ')}. ` +
        'Start it with: docker start skymatrix-mongo skymatrix-redis',
    );
  }
}

const uuidHexToDashed = (uuidHex) => {
  const hex = uuidHex.replace(/-/g, '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export { uuidHexToDashed };

/** Vanilla Minecraft server hash (spec-derived, independent of the server code). */
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

function spawnService({ label, cwd, env, logs }) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const record = { label, child, output: [] };
  const capture = (chunk) => {
    const text = String(chunk);
    record.output.push(text);
    if (logs) logs.push(`[${label}] ${text.trimEnd()}`);
    if (record.output.length > 400) record.output.splice(0, record.output.length - 400);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  return record;
}

async function waitForHttp(url, { timeoutMs = 40_000, service, what = url } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (service && service.child.exitCode !== null) {
      throw new Error(
        `${service.label} exited early (code ${service.child.exitCode}):\n${service.output.join('').slice(-4000)}`,
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      /* not listening yet */
    }
    await sleep(250);
  }
  const tail = service ? service.output.join('').slice(-4000) : '';
  throw new Error(`timed out waiting for ${what}${tail ? `\n--- service output ---\n${tail}` : ''}`);
}

/**
 * Real Minecraft-auth handshake against a (fake or real) session server:
 * challenge -> RSA shared secret -> Mojang join -> verify -> JWT.
 *
 * This is the same flow as tools/e2e/mint-token.mjs; it is re-implemented here
 * because that file is a CLI (top-level side effects, writes a token file) and
 * the harness needs to mint many identities in-process.
 */
export async function handshake({
  authBase,
  mojangBase,
  username,
  uuidHex,
  accessToken,
  clientIp = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
}) {
  const call = async (method, route, body) => {
    const response = await fetch(`${authBase}${route}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': clientIp,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };

  const challenge = await call('POST', '/api/v1/auth/minecraft/challenge', { username, client: 'fabric' });
  if (challenge.status !== 200) {
    throw new Error(`challenge failed for ${username}: HTTP ${challenge.status} ${JSON.stringify(challenge.json)}`);
  }

  const publicKeyDer = Buffer.from(challenge.json.publicKey, 'base64');
  const publicKey = createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
  const sharedSecret = randomBytes(16);
  const hash = minecraftServerHash(challenge.json.serverId, sharedSecret, publicKeyDer);

  const join = await fetch(`${mojangBase}/session/minecraft/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accessToken, selectedProfile: uuidHex, serverId: hash }),
  });
  if (join.status !== 204) {
    throw new Error(`Mojang join failed for ${username}: HTTP ${join.status}`);
  }

  const encrypt = (buffer) =>
    publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, buffer).toString('base64');

  const verified = await call('POST', '/api/v1/auth/minecraft/verify', {
    challengeId: challenge.json.challengeId,
    username,
    encryptedSharedSecret: encrypt(sharedSecret),
    encryptedVerifyToken: encrypt(Buffer.from(challenge.json.verifyToken, 'base64')),
  });
  if (verified.status !== 200) {
    throw new Error(`verify failed for ${username}: HTTP ${verified.status} ${JSON.stringify(verified.json)}`);
  }

  return {
    accessToken: verified.json.accessToken,
    refreshToken: verified.json.refreshToken,
    scopes: verified.json.scopes,
    profile: verified.json.profile,
    uuidHex,
    username,
  };
}

/**
 * Boots the whole stack. Returns a handle with the URLs, a `mint()` function and
 * `close()`. Throws (with the child process output) when a service cannot start,
 * so the harness can report "could not run" instead of "failed".
 */
export async function startManagedStack({ log = () => {}, runId = `${Date.now()}`, ...overrides } = {}) {
  const config = { ...DEFAULTS, ...overrides };
  await requireLocalInfra(config.mongoUri, config.redisUrl);

  const mongoDb = `skymatrix_irc_e2e_${runId}`;
  const logs = [];
  const services = [];
  const mojang = startFakeMojang({ port: 0 });
  const mojangBase = await mojang.listen();
  const issuer = `http://127.0.0.1:${config.authPort}`;

  const authEnv = (port, extra) => ({
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: String(port),
    LOG_LEVEL: 'warn',
    MONGODB_URI: config.mongoUri,
    MONGODB_DB: mongoDb,
    MONGODB_ENSURE_INDEXES: 'true',
    REDIS_URL: config.redisUrl,
    // Every instance must claim the SAME issuer: the IRC server verifies `iss`.
    PUBLIC_BASE_URL: issuer,
    JWT_ISSUER: issuer,
    JWT_AUDIENCE: 'skymatrix-api',
    CHALLENGE_TTL_SECONDS: '60',
    RATE_LIMIT_CHALLENGE_MAX: '500',
    RATE_LIMIT_VERIFY_MAX: '500',
    MOJANG_SESSION_SERVER: mojangBase,
    MOJANG_HAS_JOINED_ATTEMPTS: '1',
    MOJANG_RETRY_DELAY_MS: '50',
    ...extra,
  });

  const authMain = spawnService({
    label: 'auth#1',
    cwd: path.join(repoRoot, 'apps', 'auth-server'),
    env: authEnv(config.authPort, { DEFAULT_SCOPES: 'skymatrix:profile,skymatrix:ircserver' }),
    logs,
  });
  const authRestricted = spawnService({
    label: 'auth#2',
    cwd: path.join(repoRoot, 'apps', 'auth-server'),
    env: authEnv(config.restrictedAuthPort, { DEFAULT_SCOPES: 'skymatrix:profile' }),
    logs,
  });
  const authExpired = spawnService({
    label: 'auth#3',
    cwd: path.join(repoRoot, 'apps', 'auth-server'),
    env: authEnv(config.expiredAuthPort, {
      DEFAULT_SCOPES: 'skymatrix:profile,skymatrix:ircserver',
      ACCESS_TOKEN_TTL_SECONDS: '1',
    }),
    logs,
  });
  services.push(authMain, authRestricted, authExpired);

  const irc = spawnService({
    label: 'irc-server',
    cwd: path.join(repoRoot, 'apps', 'irc-server'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(config.ircPort),
      LOG_LEVEL: 'warn',
      MONGODB_URI: config.mongoUri,
      MONGODB_DB: mongoDb,
      REDIS_URL: config.redisUrl,
      AUTH_JWKS_URL: `${issuer}/api/v1/auth/jwks`,
      JWT_ISSUER: issuer,
      JWT_AUDIENCE: 'skymatrix-api',
      INSTANCE_ID: `e2e-${runId}`,
      ADMIN_UUIDS: '',
      CORS_ORIGINS: '',
    },
    logs,
  });
  services.push(irc);

  const cleanup = async () => {
    for (const service of services) {
      try {
        if (service.child.exitCode === null) service.child.kill();
      } catch {
        /* ignore */
      }
    }
    await mojang.close().catch(() => {});
  };

  try {
    await Promise.all([
      waitForHttp(`${issuer}/api/v1/health/ready`, { service: authMain, what: 'auth#1' }),
      waitForHttp(`http://127.0.0.1:${config.restrictedAuthPort}/api/v1/health/ready`, {
        service: authRestricted,
        what: 'auth#2',
      }),
      waitForHttp(`http://127.0.0.1:${config.expiredAuthPort}/api/v1/health/ready`, {
        service: authExpired,
        what: 'auth#3',
      }),
    ]);
    await waitForHttp(`http://127.0.0.1:${config.ircPort}/health/ready`, { service: irc, what: 'irc-server' });
  } catch (error) {
    await cleanup();
    throw error;
  }

  log(`fake Mojang on ${mojangBase}`);
  log(`auth#1 ${issuer}  auth#2 :${config.restrictedAuthPort}  auth#3 :${config.expiredAuthPort}`);
  log(`irc-server http://127.0.0.1:${config.ircPort}  (mongo db ${mongoDb})`);

  let counter = 0;
  const mint = async ({ username, uuidHex, from = 'main' }) => {
    counter += 1;
    const resolvedUsername = username ?? `Player${counter}`;
    const resolvedUuid = (uuidHex ?? createHash('md5').update(`${runId}-${resolvedUsername}-${counter}`).digest('hex')).toLowerCase();
    const authBase = {
      main: issuer,
      restricted: `http://127.0.0.1:${config.restrictedAuthPort}`,
      expired: `http://127.0.0.1:${config.expiredAuthPort}`,
    }[from];
    if (!authBase) throw new Error(`unknown auth source ${from}`);
    const session = await handshake({
      authBase,
      mojangBase,
      username: resolvedUsername,
      uuidHex: resolvedUuid,
      // Test-only convention understood by fake-mojang: identity lives in the token.
      accessToken: `${resolvedUuid}.${resolvedUsername}`,
    });
    return { ...session, minecraftUuid: uuidHexToDashed(resolvedUuid) };
  };

  return {
    kind: 'managed',
    mongoDb,
    infos: { fakeMojang: mojangBase, auth: issuer, irc: `http://127.0.0.1:${config.ircPort}` },
    ircHttpUrl: `http://127.0.0.1:${config.ircPort}`,
    ircWsUrl: `ws://127.0.0.1:${config.ircPort}/v1/connect`,
    issuer,
    mint,
    logs,
    processes: services,
    close: cleanup,
  };
}

/**
 * Mints a token for an existing (external) deployment through the real Mojang
 * session server, using the TEST_ACCESSTOKEN the rest of the repo already uses.
 */
export async function mintFromRealMojang({
  authBase,
  accessToken,
  mojangBase = process.env.E2E_MOJANG_URL ?? 'https://sessionserver.mojang.com',
  profileBase = 'https://api.minecraftservices.com',
}) {
  const profileResponse = await fetch(`${profileBase}/minecraft/profile`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!profileResponse.ok) {
    throw new Error(
      `Mojang profile lookup failed with HTTP ${profileResponse.status} — TEST_ACCESSTOKEN is missing or expired`,
    );
  }
  const profile = await profileResponse.json();
  const uuidHex = String(profile.id).replace(/-/g, '').toLowerCase();
  return handshake({
    authBase,
    mojangBase,
    username: String(profile.name),
    uuidHex,
    accessToken,
  });
}
