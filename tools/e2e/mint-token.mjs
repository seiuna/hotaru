/**
 * Mints a real admin access token from a running auth server.
 *
 * It performs the genuine Minecraft handshake against Mojang (using the token in
 * apps/auth-server/.env) and the auth server that is already running, so the
 * resulting JWT is signed by THAT instance's key — which is what a browser
 * session needs. The token is written to a file, never printed.
 *
 * Usage:
 *   node tools/e2e/mint-token.mjs --base http://127.0.0.1:3000 --out tools/e2e/.token.json
 */
import {
  constants,
  createHash,
  createPublicKey,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const APP_ENV = path.join(repoRoot, 'apps', 'auth-server', '.env');

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const BASE = arg('base', 'http://127.0.0.1:3000').replace(/\/$/, '');
const OUT = path.resolve(repoRoot, arg('out', 'tools/e2e/.token.json'));

function loadEnv(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

const env = { ...loadEnv(APP_ENV), ...loadEnv(path.join(here, '.env.real')) };
const accessToken = process.env.TEST_ACCESSTOKEN ?? env.TEST_ACCESSTOKEN ?? env.MC_ACCESS_TOKEN;
if (!accessToken) {
  console.error('No TEST_ACCESSTOKEN in apps/auth-server/.env');
  process.exit(2);
}

function serverHash(serverId, sharedSecret, publicKeyDer) {
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

async function api(method, route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: {
      'content-type': 'application/json',
      // Fresh client IP so the mint is not throttled by earlier runs.
      'x-forwarded-for': `10.9.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function main() {
  const profileRes = await fetch('https://api.minecraftservices.com/minecraft/profile', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!profileRes.ok) {
    console.error(`profile lookup failed: HTTP ${profileRes.status} (token expired?)`);
    process.exit(1);
  }
  const profile = await profileRes.json();
  const username = String(profile.name);
  const uuidHex = String(profile.id).replace(/-/g, '').toLowerCase();

  const challenge = await api('POST', '/api/v1/auth/minecraft/challenge', { username, client: 'fabric' });
  if (challenge.status !== 200) {
    console.error('challenge failed', challenge.status, JSON.stringify(challenge.json));
    process.exit(1);
  }

  const publicKeyDer = Buffer.from(challenge.json.publicKey, 'base64');
  const publicKey = createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
  const sharedSecret = randomBytes(16);
  const hash = serverHash(challenge.json.serverId, sharedSecret, publicKeyDer);

  const join = await fetch('https://sessionserver.mojang.com/session/minecraft/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accessToken, selectedProfile: uuidHex, serverId: hash }),
  });
  if (join.status !== 204) {
    console.error(`Mojang join failed: HTTP ${join.status}`);
    process.exit(1);
  }

  const encrypt = (buffer) =>
    publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, buffer).toString('base64');

  const verified = await api('POST', '/api/v1/auth/minecraft/verify', {
    challengeId: challenge.json.challengeId,
    username,
    encryptedSharedSecret: encrypt(sharedSecret),
    encryptedVerifyToken: encrypt(Buffer.from(challenge.json.verifyToken, 'base64')),
  });
  if (verified.status !== 200) {
    console.error('verify failed', verified.status, JSON.stringify(verified.json));
    process.exit(1);
  }

  const payload = {
    accessToken: verified.json.accessToken,
    refreshToken: verified.json.refreshToken,
    profile: verified.json.profile,
    scopes: verified.json.scopes,
    mintedAt: new Date().toISOString(),
    server: BASE,
  };
  writeFileSync(OUT, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`token minted for ${username} (${dashed(uuidHex)}), scopes=${verified.json.scopes.join(',')}`);
  console.log(`written to ${OUT} (git-ignored)`);
}

main().catch((error) => {
  console.error('mint failed:', error.message);
  process.exit(1);
});
