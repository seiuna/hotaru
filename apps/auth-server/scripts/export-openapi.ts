/**
 * Exports the OpenAPI document without touching MongoDB or Redis.
 *
 * `buildApp()` only needs an AppContext shape: route modules read `ctx.config`,
 * `ctx.keys` and (inside handlers, never at registration time) `ctx.redis`.
 * So instead of `connectMongo()` + `initKeys()` — both of which need a live
 * database — this script:
 *
 *   1. builds a fully validated AppConfig from fixed, safe test values,
 *   2. generates throw-away Ed25519 + RSA-1024 key pairs with node:crypto,
 *   3. passes an inert Redis proxy that answers any method with a rejected
 *      promise (it is never awaited during registration),
 *   4. boots the real app, calls app.ready() so every route is registered,
 *      then serialises app.swagger() to docs/openapi.json and docs/openapi.yaml.
 *
 * Run with: pnpm --filter @skymatrix/auth-server openapi:export
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateKeyPairSync,
} from 'node:crypto';
import { calculateJwkThumbprint, exportJWK } from 'jose';
import type { Redis } from 'ioredis';

import { loadConfig } from '../src/config/env.js';
import { buildApp } from '../src/app.js';
import type { AppContext } from '../src/context.js';
import type { ServiceKeys } from '../src/infrastructure/crypto/keys.js';

const scriptDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(scriptDir, '../../..');
const docsDir = resolve(repoRoot, 'docs');

/** Fully valid values: the config parser is real, only the backend is absent. */
function buildConfig() {
  return loadConfig({
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '3000',
    LOG_LEVEL: 'silent',

    MONGODB_URI: 'mongodb://127.0.0.1:27017/skymatrix_openapi_export',
    MONGODB_DB: 'skymatrix_openapi_export',
    REDIS_URL: 'redis://127.0.0.1:16379',

    PUBLIC_BASE_URL: 'https://auth.example.com',
    JWT_ISSUER: 'https://auth.example.com',
    JWT_AUDIENCE: 'skymatrix-api',

    ACCESS_TOKEN_TTL_SECONDS: '900',
    REFRESH_TOKEN_TTL_DAYS: '7',
    CHALLENGE_TTL_SECONDS: '60',

    RATE_LIMIT_WINDOW_SECONDS: '60',
    RATE_LIMIT_CHALLENGE_MAX: '10',
    RATE_LIMIT_VERIFY_MAX: '10',

    MOJANG_SESSION_SERVER: 'https://sessionserver.mojang.com',
    MOJANG_HAS_JOINED_TIMEOUT_MS: '5000',
    MOJANG_HAS_JOINED_ATTEMPTS: '2',
    MOJANG_RETRY_DELAY_MS: '500',

    DEFAULT_SCOPES: 'skymatrix:profile',
    CORS_ORIGINS: '',
  });
}

/**
 * Same shape `initKeys()` returns, produced without reading or writing the
 * `service_keys` collection. The keys are generated per run and discarded.
 */
async function buildEphemeralKeys(): Promise<ServiceKeys> {
  const jwtPair = generateKeyPairSync('ed25519');
  const jwtPublicJwk = await exportJWK(jwtPair.publicKey);
  const kid = await calculateJwkThumbprint(jwtPublicJwk, 'sha256');

  const minecraftPair = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const publicKeyDer = minecraftPair.publicKey.export({ type: 'spki', format: 'der' });

  return {
    jwt: {
      privateKey: jwtPair.privateKey,
      publicKey: jwtPair.publicKey,
      kid,
      alg: 'EdDSA',
      publicJwk: { ...jwtPublicJwk, kid, use: 'sig', alg: 'EdDSA' },
    },
    minecraft: {
      privateKey: minecraftPair.privateKey,
      publicKeyDer,
      publicKeyBase64: publicKeyDer.toString('base64'),
    },
  };
}

/**
 * Route registration never talks to Redis (only request handlers do), so an
 * inert proxy is enough: any property access yields a function that rejects
 * loudly if a handler is somehow executed during the export.
 */
function createRedisStub(): Redis {
  const cache = new Map<string, unknown>();
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (property === 'then') return undefined; // do not become a thenable
        if (typeof property === 'symbol') return undefined;
        if (!cache.has(property)) {
          const reject = (): Promise<never> =>
            Promise.reject(new Error(`Redis is not available during OpenAPI export (${property})`));
          cache.set(property, property === 'status' ? 'ready' : reject);
        }
        return cache.get(property);
      },
      has: () => false,
    },
  ) as unknown as Redis;
}

/* ------------------------------------------------------------------ */
/* Minimal YAML writer (no dependency): JSON-compatible data only.     */
/* ------------------------------------------------------------------ */

const pad = (indent: number): string => ' '.repeat(indent);

/** Keys that must stay strings even though they look like plain scalars. */
const AMBIGUOUS = /^(true|false|null|yes|no|on|off|y|n|~)$/i;
const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const PLAIN_VALUE = /^[A-Za-z_][A-Za-z0-9_./-]*$/;

function scalar(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const text = typeof value === 'string' ? value : String(value);
  if (text.length === 0) return "''";
  if (PLAIN_VALUE.test(text) && !AMBIGUOUS.test(text)) return text;
  // A JSON string is a valid YAML double-quoted scalar.
  return JSON.stringify(text);
}

function keyName(key: string): string {
  if (PLAIN_KEY.test(key) && !AMBIGUOUS.test(key)) return key;
  return JSON.stringify(key);
}

const isScalar = (value: unknown): boolean => value === null || typeof value !== 'object';

function emitEntry(
  key: string,
  value: unknown,
  indent: number,
  lines: string[],
  prefix = '',
): void {
  const head = `${pad(indent)}${prefix}${keyName(key)}:`;
  // A prefixed entry (`- key:`) puts the key two columns further right, so its
  // nested block has to be indented by the prefix length as well.
  const childIndent = indent + prefix.length;

  if (isScalar(value)) {
    lines.push(`${head} ${scalar(value)}`);
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${head} []`);
      return;
    }
    lines.push(head);
    emitNode(value, childIndent + 2, lines);
    return;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    lines.push(`${head} {}`);
    return;
  }
  lines.push(head);
  emitNode(value, childIndent + 2, lines);
}

function emitNode(value: unknown, indent: number, lines: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isScalar(item)) {
        lines.push(`${pad(indent)}- ${scalar(item)}`);
        continue;
      }
      if (Array.isArray(item)) {
        if (item.length === 0) {
          lines.push(`${pad(indent)}- []`);
          continue;
        }
        lines.push(`${pad(indent)}-`);
        emitNode(item, indent + 2, lines);
        continue;
      }
      const entries = Object.entries(item as Record<string, unknown>);
      if (entries.length === 0) {
        lines.push(`${pad(indent)}- {}`);
        continue;
      }
      const [first, ...rest] = entries;
      if (!first) continue;
      emitEntry(first[0], first[1], indent, lines, '- ');
      for (const [key, child] of rest) emitEntry(key, child, indent + 2, lines);
    }
    return;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, child] of entries) emitEntry(key, child, indent, lines);
}

function toYaml(document: Record<string, unknown>): string {
  const lines: string[] = [];
  emitNode(document, 0, lines);
  return `${lines.join('\n')}\n`;
}

/* ------------------------------------------------------------------ */

interface OpenApiDocument {
  openapi: string;
  paths?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

/**
 * Paths the platform promises to expose; a missing one fails the export. Fastify
 * rewrites `:id` parameters as `{id}`, which is why the parametrised paths are
 * spelled that way here.
 */
const EXPECTED_PATHS = [
  '/api/v1/auth/minecraft/challenge',
  '/api/v1/auth/minecraft/verify',
  '/api/v1/auth/refresh',
  '/api/v1/auth/logout',
  '/api/v1/auth/jwks',
  '/api/v1/users/me',
  '/api/v1/users/me/permissions',
  '/api/v1/admin/users',
  '/api/v1/admin/users/{id}/permissions',
  '/api/v1/admin/users/{id}/ban',
  '/api/v1/admin/users/{id}/unban',
  '/api/v1/admin/sessions/{id}/revoke',
  '/api/v1/admin/audit-logs',
  '/api/v1/health/live',
  '/api/v1/health/ready',
];

async function main(): Promise<void> {
  const config = buildConfig();
  const keys = await buildEphemeralKeys();
  const ctx: AppContext = { config, keys, redis: createRedisStub() };

  const app = await buildApp(ctx);
  try {
    await app.ready();

    const document = app.swagger() as unknown as OpenApiDocument;
    const paths = document.paths ?? {};
    const pathKeys = Object.keys(paths).sort();

    await mkdir(docsDir, { recursive: true });
    await writeFile(resolve(docsDir, 'openapi.json'), `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    await writeFile(resolve(docsDir, 'openapi.yaml'), toYaml(document as unknown as Record<string, unknown>), 'utf8');

    let operationCount = 0;
    for (const item of Object.values(paths)) {
      operationCount += Object.keys(item).filter((method) =>
        ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method),
      ).length;
    }

    console.log(`OpenAPI document written to docs/openapi.json and docs/openapi.yaml`);
    console.log(`  OpenAPI version : ${document.openapi}`);
    console.log(`  Paths           : ${pathKeys.length}`);
    console.log(`  Operations      : ${operationCount}`);
    for (const path of pathKeys) {
      const methods = Object.keys(paths[path] ?? {})
        .filter((method) => method !== 'parameters' && method !== 'summary')
        .map((method) => method.toUpperCase())
        .join(', ');
      console.log(`    ${methods.padEnd(12)} ${path}`);
    }

    const missing = EXPECTED_PATHS.filter((path) => !pathKeys.includes(path));
    if (missing.length > 0) {
      console.error(`\n[error] documented paths missing from the app: ${missing.join(', ')}`);
      process.exitCode = 1;
    }
    if (pathKeys.length === 0) {
      console.error('\n[error] the app exposed no routes; the export would be useless');
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error('[fatal] OpenAPI export failed:', error);
  process.exit(1);
});
