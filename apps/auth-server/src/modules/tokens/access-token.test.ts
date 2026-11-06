import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { exportJWK, jwtVerify } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import type { JwtKeys } from '../../infrastructure/crypto/keys.js';
import { signAccessToken } from './access-token.js';

const ISSUER = 'https://auth.test.local';
const AUDIENCE = 'skymatrix-api';
const TTL_SECONDS = 900;
const NOW_SECONDS = 1_700_000_000;
/** Verification clock pinned just after issuance so `exp` is in the future. */
const VERIFY_NOW = new Date((NOW_SECONDS + 10) * 1000);

let jwtKeys: JwtKeys;
let foreignPublicKey: KeyObject;

beforeAll(async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicJwk = await exportJWK(publicKey);
  jwtKeys = { privateKey, publicKey, kid: 'test-kid', alg: 'EdDSA', publicJwk };
  foreignPublicKey = generateKeyPairSync('ed25519').publicKey;
});

const sign = () =>
  signAccessToken(jwtKeys, {
    userId: '65f1f3e2a1b2c3d4e5f60718',
    minecraftUuid: '01234567-89ab-cdef-0123-456789abcdef',
    sessionId: '65f1f3e2a1b2c3d4e5f60719',
    scopes: ['skymatrix:profile', 'skymatrix:resource'],
    issuer: ISSUER,
    audience: AUDIENCE,
    ttlSeconds: TTL_SECONDS,
    nowSeconds: NOW_SECONDS,
  });

describe('signAccessToken', () => {
  it('signs an EdDSA token carrying exactly the documented claims', async () => {
    const signed = await sign();
    const { payload, protectedHeader } = await jwtVerify(signed.token, jwtKeys.publicKey, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['EdDSA'],
      currentDate: VERIFY_NOW,
    });

    expect(protectedHeader.alg).toBe('EdDSA');
    expect(protectedHeader.kid).toBe('test-kid');

    expect(payload.iss).toBe(ISSUER);
    expect(payload.sub).toBe('65f1f3e2a1b2c3d4e5f60718');
    expect(payload.aud).toEqual([AUDIENCE]);
    expect(payload.minecraft_uuid).toBe('01234567-89ab-cdef-0123-456789abcdef');
    expect(payload.sid).toBe('65f1f3e2a1b2c3d4e5f60719');
    expect(payload.scope).toBe('skymatrix:profile skymatrix:resource');
    expect(payload.iat).toBe(NOW_SECONDS);
    expect(payload.exp).toBe(NOW_SECONDS + TTL_SECONDS);
    expect(payload.jti).toBe(signed.jti);
    expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/);

    expect(signed.expiresAt.getTime()).toBe((NOW_SECONDS + TTL_SECONDS) * 1000);
    expect(signed.expiresIn).toBe(TTL_SECONDS);
  });

  it('uses a fresh jti for every token', async () => {
    const first = await sign();
    const second = await sign();

    expect(first.jti).not.toBe(second.jti);
    expect(first.token).not.toBe(second.token);
  });

  it('encodes an empty scope list as an empty string', async () => {
    const signed = await signAccessToken(jwtKeys, {
      userId: '65f1f3e2a1b2c3d4e5f60718',
      minecraftUuid: '01234567-89ab-cdef-0123-456789abcdef',
      sessionId: '65f1f3e2a1b2c3d4e5f60719',
      scopes: [],
      issuer: ISSUER,
      audience: AUDIENCE,
      ttlSeconds: TTL_SECONDS,
      nowSeconds: NOW_SECONDS,
    });

    const { payload } = await jwtVerify(signed.token, jwtKeys.publicKey, {
      issuer: ISSUER,
      audience: AUDIENCE,
      currentDate: VERIFY_NOW,
    });
    expect(payload.scope).toBe('');
  });

  it('cannot be verified with a different key, audience or issuer', async () => {
    const signed = await sign();

    await expect(
      jwtVerify(signed.token, foreignPublicKey, { issuer: ISSUER, currentDate: VERIFY_NOW }),
    ).rejects.toThrow();

    await expect(
      jwtVerify(signed.token, jwtKeys.publicKey, {
        issuer: ISSUER,
        audience: 'someone-else',
        currentDate: VERIFY_NOW,
      }),
    ).rejects.toThrow();

    await expect(
      jwtVerify(signed.token, jwtKeys.publicKey, {
        issuer: 'https://evil.test',
        audience: AUDIENCE,
        currentDate: VERIFY_NOW,
      }),
    ).rejects.toThrow();
  });

  it('expires after the configured ttl', async () => {
    const signed = await sign();

    await expect(
      jwtVerify(signed.token, jwtKeys.publicKey, {
        issuer: ISSUER,
        audience: AUDIENCE,
        currentDate: new Date((NOW_SECONDS + TTL_SECONDS + 1) * 1000),
      }),
    ).rejects.toThrow(/exp/i);
  });
});
