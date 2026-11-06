/**
 * End-to-end check of the browser → local mod bridge → auth server chain.
 *
 * It starts the Java bridge (which behaves like a mod: loopback server + real Mojang handshake), then
 * talks to it exactly as Chrome would from the admin console — including the Private Network Access
 * preflight — and finally uses the returned JWT against the real auth server.
 *
 * Run: node tools/e2e/bridge-login.mjs
 * Requires: auth server on :3000 with containers up, TEST_ACCESSTOKEN in apps/auth-server/.env,
 *           clients/fabric-sdk-java/out compiled (javac).
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const AUTH_BASE = process.env.AUTH_BASE ?? 'http://127.0.0.1:3000';
const ORIGIN = process.env.BRIDGE_ORIGIN ?? 'http://localhost:5173';
const JAVA_DIR = path.join(repoRoot, 'clients', 'fabric-sdk-java');
const CLASSES = path.join(JAVA_DIR, 'out');

let failures = 0;
let checks = 0;
const check = (name, condition, detail = '') => {
  checks += 1;
  if (condition) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`);
  }
};

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

const envFile = loadEnv(path.join(repoRoot, 'apps', 'auth-server', '.env'));
const accessToken = process.env.TEST_ACCESSTOKEN ?? envFile.TEST_ACCESSTOKEN;
if (!accessToken) {
  console.error('No TEST_ACCESSTOKEN in apps/auth-server/.env');
  process.exit(2);
}
if (!existsSync(CLASSES)) {
  console.error(`Java classes missing at ${CLASSES}. Run: cd clients/fabric-sdk-java && javac -d out "@sources.txt"`);
  process.exit(2);
}

async function startBridge() {
  const child = spawn(
    'java',
    ['-cp', 'out', 'com.skymatrix.mcauth.bridge.BridgeDemo'],
    {
      cwd: JAVA_DIR,
      env: {
        ...process.env,
        TEST_ACCESSTOKEN: accessToken,
        AUTH_BASE,
        BRIDGE_PORT: '0',
        BRIDGE_SECONDS: '90',
        BRIDGE_ORIGINS: ORIGIN,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const logs = [];
  let port = null;
  child.stdout.on('data', (chunk) => {
    const text = String(chunk);
    logs.push(text);
    const match = /BRIDGE_PORT=(\d+)/.exec(text);
    if (match && !port) port = Number(match[1]);
  });
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !port) {
    if (child.exitCode !== null) {
      throw new Error(`bridge exited early (${child.exitCode}):\n${logs.join('')}`);
    }
    await sleep(200);
  }
  if (!port) throw new Error(`bridge never reported a port:\n${logs.join('')}`);
  return { child, port, logs };
}

async function main() {
  const bridge = await startBridge();
  const base = `http://127.0.0.1:${bridge.port}`;
  console.log(`bridge listening on ${base} (origin ${ORIGIN})\n`);

  try {
    console.log('== 1. probe (what the login page does on mount) ==');
    const health = await fetch(`${base}/v1/health`, { headers: { origin: ORIGIN } });
    const healthBody = await health.json();
    check('health returns 200', health.status === 200, String(health.status));
    check('health identifies the local mod bridge', healthBody?.service === 'skymatrix-local-auth', JSON.stringify(healthBody));
    check(
      'health tells the page approval is required',
      healthBody?.requiresApproval === true,
    );

    console.log('\n== 2. CORS / Private Network Access preflight ==');
    const preflight = await fetch(`${base}/v1/login`, {
      method: 'OPTIONS',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
        'access-control-request-private-network': 'true',
      },
    });
    check('preflight returns 204', preflight.status === 204, String(preflight.status));
    check(
      'preflight allows this exact origin',
      preflight.headers.get('access-control-allow-origin') === ORIGIN,
      String(preflight.headers.get('access-control-allow-origin')),
    );
    check(
      'preflight allows Private Network Access (Chromium requirement)',
      preflight.headers.get('access-control-allow-private-network') === 'true',
      String(preflight.headers.get('access-control-allow-private-network')),
    );

    console.log('\n== 3. login through the bridge (real Mojang handshake) ==');
    const started = Date.now();
    const login = await fetch(`${base}/v1/login`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: '{}',
    });
    const issued = await login.json().catch(() => null);
    check('bridge issues a token', login.status === 200, `${login.status} ${JSON.stringify(issued)}`);
    if (login.status !== 200) {
      console.log(JSON.stringify(issued));
      return;
    }
    console.log(`  info  mint took ${Date.now() - started} ms`);
    check('token payload matches the API contract', typeof issued.accessToken === 'string' && issued.accessToken.startsWith('eyJ'));
    check('bridge returns the refresh token', typeof issued.refreshToken === 'string' && issued.refreshToken.length > 20);
    check('bridge returns the Mojang profile', typeof issued.profile?.uuid === 'string' && typeof issued.profile?.username === 'string');
    check('bridge returns scopes', Array.isArray(issued.scopes));
    check('login response is not cacheable', login.headers.get('cache-control') === 'no-store', String(login.headers.get('cache-control')));

    console.log('\n== 4. the browser can use that token against the real API ==');
    const me = await fetch(`${AUTH_BASE}/api/v1/users/me`, {
      headers: { authorization: `Bearer ${issued.accessToken}` },
    });
    const meBody = await me.json();
    check('GET /users/me accepts the bridge-issued token', me.status === 200, `${me.status} ${JSON.stringify(meBody)}`);
    check('identity matches the player', meBody?.user?.minecraftUuid === issued.profile.uuid, `${meBody?.user?.minecraftUuid} vs ${issued.profile.uuid}`);
    const perms = await fetch(`${AUTH_BASE}/api/v1/users/me/permissions`, {
      headers: { authorization: `Bearer ${issued.accessToken}` },
    });
    const permsBody = await perms.json();
    check('permissions endpoint works with it', perms.status === 200 && Array.isArray(permsBody?.scopes), JSON.stringify(permsBody));
    console.log(`  info  scopes: ${permsBody?.scopes?.join(', ') ?? '—'}`);

    console.log('\n== 5. a foreign origin must be refused ==');
    const foreign = await fetch(`${base}/v1/login`, {
      method: 'POST',
      headers: { origin: 'https://evil.example.com', 'content-type': 'application/json' },
      body: '{}',
    });
    check('foreign origin is rejected', foreign.status === 403, String(foreign.status));
    check(
      'no access-control-allow-origin leaks to the foreign origin',
      foreign.headers.get('access-control-allow-origin') === null,
      String(foreign.headers.get('access-control-allow-origin')),
    );
  } finally {
    bridge.child.kill('SIGKILL');
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    console.log(`${failures} FAILED`);
    process.exitCode = 1;
  } else {
    console.log('BRIDGE LOGIN OK');
  }
}

main().catch((error) => {
  console.error('\nBRIDGE LOGIN FAILED:', error.message);
  process.exitCode = 1;
});
