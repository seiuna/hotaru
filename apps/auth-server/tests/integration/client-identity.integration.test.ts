import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  purgeAuthCoreData,
  startHarness,
  stopHarness,
  type AuthCoreHarness,
} from './support/auth-core-harness.js';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const otherPublicKey = generateKeyPairSync('ed25519').publicKey
  .export({ type: 'spki', format: 'der' })
  .toString('base64');

let harness: AuthCoreHarness;

async function challenge(client: unknown) {
  return harness.app.inject({
    method: 'POST',
    url: '/api/v1/auth/minecraft/challenge',
    payload: { username: 'ClientTest', ...(client === undefined ? {} : { client }) },
  });
}

beforeAll(async () => {
  harness = await startHarness({
    CLIENT_KEYS: JSON.stringify({ 'test-client': publicKey }),
  });
});

beforeEach(async () => {
  await purgeAuthCoreData(harness.redis);
});

afterAll(async () => {
  await stopHarness(harness);
});

describe('client identity', () => {
  it('accepts a registered client public key', async () => {
    const response = await challenge({
      id: 'test-client',
      version: '1.4.0',
      publicKey,
    });
    expect(response.statusCode).toBe(200);
  });

  it('requires a client identity when keys are configured', async () => {
    const response = await challenge(undefined);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('CLIENT_REQUIRED');
  });

  it('rejects unknown client ids', async () => {
    const response = await challenge({ id: 'unknown-client', publicKey });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('CLIENT_UNKNOWN');
  });

  it('rejects a key that does not belong to the client id', async () => {
    const response = await challenge({ id: 'test-client', publicKey: otherPublicKey });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('CLIENT_KEY_MISMATCH');
  });
});
