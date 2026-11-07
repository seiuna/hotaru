/* global URL, process */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  main,
  parseEnv,
  runSetup,
  setEnvValue,
  validators,
  writeFiles,
} from './setup.mjs';

const setupPath = fileURLToPath(new URL('./setup.mjs', import.meta.url));
const examplePath = fileURLToPath(new URL('../../deploy/.env.example', import.meta.url));

function fakeIo(overrides = {}) {
  return {
    interactive: false,
    log: () => {},
    ask: async (field) => overrides[field.key] ?? field.defaultValue ?? '',
    confirm: async () => true,
  };
}

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'hotaru-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('setEnvValue updates values, appends missing keys, and preserves comments', () => {
  const text = '# comment\nKEY1=value1\n# another\nOTHER=keep';
  const updated = setEnvValue(text, 'KEY1', 'newvalue');
  assert.match(updated, /# comment/);
  assert.match(updated, /KEY1=newvalue/);
  assert.match(updated, /OTHER=keep/);

  const added = setEnvValue(text, 'KEY3', 'value3');
  assert.match(added, /KEY3=value3/);
  assert.match(added, /# another/);

  const crlf = setEnvValue('# c\r\nKEY=old\r\nOTHER=1\r\n', 'KEY', 'new');
  assert.match(crlf, /KEY=new/);
  assert.ok(crlf.includes('\r\n'));
});

test('validators reject unsafe values and accept valid ones', () => {
  assert.equal(validators.hostname('auth.example.com'), null);
  assert.notEqual(validators.hostname('https://auth.example.com'), null);
  assert.notEqual(validators.hostname('auth example.com'), null);
  assert.notEqual(validators.hostname('localhost'), null);

  assert.equal(validators.email('ops@example.com'), null);
  assert.notEqual(validators.email('ops@example'), null);

  assert.equal(validators.publicBaseUrl('https://auth.example.com'), null);
  assert.notEqual(validators.publicBaseUrl('https://auth.example.com/api'), null);
  assert.notEqual(validators.httpsUrl('http://auth.example.com'), null);

  assert.equal(validators.mongo('mongodb://127.0.0.1:27017'), null);
  assert.notEqual(validators.mongo('http://127.0.0.1'), null);
  assert.equal(validators.redis('redis://127.0.0.1:16379'), null);
  assert.notEqual(validators.redis('http://127.0.0.1:16379'), null);

  assert.equal(validators.dbName('hotaru_auth'), null);
  assert.notEqual(validators.dbName('hotaru auth'), null);
  assert.notEqual(validators.dbName('hotaru.auth'), null);

  assert.equal(validators.scopeList('hotaru:profile,admin:users'), null);
  assert.notEqual(validators.scopeList('hotaru:*'), null);
  assert.notEqual(validators.scopeList('a,a'), null);
  assert.notEqual(validators.secret('short'), null);
  assert.equal(validators.secret('A'.repeat(24)), null);
});

test('local profile writes both env files and derives the IRC contract', async (t) => {
  const root = await tempRoot(t);
  await mkdir(join(root, 'apps/auth-server'), { recursive: true });
  await writeFile(
    join(root, 'apps/auth-server/.env'),
    '# local values\nMONGODB_DB=hotaru_auth\nTEST_ACCESSTOKEN=keep-me\n',
    'utf8',
  );

  const io = fakeIo();
  const result = await runSetup({ root, profileId: 'local', io });
  await writeFiles(result.files);

  const auth = await readFile(join(root, 'apps/auth-server/.env'), 'utf8');
  assert.match(auth, /# local values/);
  assert.match(auth, /TEST_ACCESSTOKEN=keep-me/);
  assert.match(auth, /MONGODB_DB=hotaru_auth/);

  const irc = await readFile(join(root, 'apps/irc-server/.env'), 'utf8');
  assert.match(irc, /MONGODB_URI=mongodb:\/\/127\.0\.0\.1:27017/);
  assert.match(irc, /REDIS_URL=redis:\/\/127\.0\.0\.1:16379/);
  assert.match(irc, /AUTH_JWKS_URL=http:\/\/localhost:3000\/api\/v1\/auth\/jwks/);
  assert.match(irc, /JWT_ISSUER=http:\/\/localhost:3000/);
  assert.match(irc, /JWT_AUDIENCE=hotaru-api/);
  assert.match(irc, /MONGODB_DB=hotaru_irc/);
  assert.match(irc, /INSTANCE_ID=irc-01/);
});

test('production profile seeds from the example and writes generated secrets', async (t) => {
  const root = await tempRoot(t);
  const example = await readFile(examplePath, 'utf8');
  await mkdir(join(root, 'deploy'), { recursive: true });
  await writeFile(join(root, 'deploy/.env.example'), example, 'utf8');

  const io = fakeIo({
    AUTH_DOMAIN: 'auth.test',
    ACME_EMAIL: 'ops@test.dev',
    IRC_DOMAIN: 'irc.test',
  });
  const result = await runSetup({ root, profileId: 'production', io });
  await writeFiles(result.files);

  const text = await readFile(join(root, 'deploy/.env'), 'utf8');
  assert.match(text, /# --- Public identity/);
  assert.match(text, /# Copy to deploy\/\.env/);

  const env = parseEnv(text);
  assert.equal(env.AUTH_DOMAIN, 'auth.test');
  assert.equal(env.PUBLIC_BASE_URL, 'https://auth.test');
  assert.equal(env.ADMIN_DOMAIN, 'admin.auth.test');
  assert.equal(env.IRC_DOMAIN, 'irc.test');
  assert.equal(env.MONGODB_DB, 'hotaru_auth');
  assert.equal(env.MONGODB_IRC_DB, 'hotaru_irc');
  assert.equal(env.JWT_AUDIENCE, 'hotaru-api');

  assert.match(env.MONGO_INITDB_ROOT_PASSWORD, /^[A-Za-z0-9._~-]{16,}$/);
  assert.match(env.REDIS_PASSWORD, /^[A-Za-z0-9._~-]{16,}$/);
  assert.notEqual(env.MONGO_INITDB_ROOT_PASSWORD, 'CHANGE_ME_mongo_password');
  assert.notEqual(env.REDIS_PASSWORD, 'CHANGE_ME_redis_password');
});

test('dry-run and help do not write files', async (t) => {
  const root = await tempRoot(t);
  const dry = spawnSync(
    process.execPath,
    [setupPath, '--profile', 'local', '--yes', '--dry-run', '--root', root],
    { encoding: 'utf8' },
  );
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /预览/);
  assert.equal(existsSync(join(root, 'apps/auth-server/.env')), false);

  const help = spawnSync(process.execPath, [setupPath, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /pnpm run setup/);
  assert.match(help.stdout, /--profile/);
});

test('main writes the planned files after confirmation', async (t) => {
  const root = await tempRoot(t);
  let output = '';
  const io = {
    interactive: false,
    log: () => {},
    ask: async (field) => field.defaultValue ?? '',
    confirm: async () => true,
  };

  const code = await main(
    ['node', setupPath, '--profile', 'local', '--root', root],
    { io, output: { write: (text) => { output += text; } } },
  );

  assert.equal(code, 0);
  assert.equal(existsSync(join(root, 'apps/auth-server/.env')), true);
  assert.equal(existsSync(join(root, 'apps/irc-server/.env')), true);
  assert.match(output, /已写入 2 个文件/);
});

test('interactive CLI accepts piped answers and writes production config', async (t) => {
  const root = await tempRoot(t);
  await mkdir(join(root, 'deploy'), { recursive: true });
  await writeFile(join(root, 'deploy/.env.example'), await readFile(examplePath, 'utf8'), 'utf8');

  const input = 'auth.test\nops@test.dev\n\n\nirc.test\n\n\n\n\n\ny\n';
  const result = spawnSync(
    process.execPath,
    [setupPath, '--profile', 'production', '--root', root],
    { input, encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  const env = parseEnv(await readFile(join(root, 'deploy/.env'), 'utf8'));
  assert.equal(env.AUTH_DOMAIN, 'auth.test');
  assert.equal(env.ADMIN_DOMAIN, 'admin.auth.test');
  assert.equal(env.IRC_DOMAIN, 'irc.test');
  assert.match(env.MONGO_INITDB_ROOT_PASSWORD, /^[A-Za-z0-9._~-]{16,}$/);
});

test('production --yes fails when required values have no defaults', async (t) => {
  const root = await tempRoot(t);
  await mkdir(join(root, 'deploy'), { recursive: true });
  await writeFile(join(root, 'deploy/.env.example'), await readFile(examplePath, 'utf8'), 'utf8');

  await assert.rejects(
    runSetup({ root, profileId: 'production', io: fakeIo(), yes: true }),
    /AUTH_DOMAIN 不能为空/,
  );
  assert.equal(existsSync(join(root, 'deploy/.env')), false);
});
