import {
  constants,
  generateKeyPairSync,
  publicEncrypt,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../errors.js';
import { decodeBase64, decryptRsaPkcs1, safeEqual } from './crypto.js';

const rsaPair = (): { privateKey: KeyObject; publicKey: KeyObject } => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  return { privateKey, publicKey };
};

const encrypt = (publicKey: KeyObject, plaintext: Buffer): Buffer =>
  publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, plaintext);

/**
 * A 128-byte value guaranteed to be >= the RSA modulus, which OpenSSL always
 * rejects ("data greater than mod len", no implicit rejection). This pins the
 * deterministic decrypt-error path without relying on random padding luck.
 */
const ciphertextAboveModulus = (privateKey: KeyObject): Buffer => {
  const jwk = privateKey.export({ format: 'jwk' });
  const modulusBase64Url = jwk.n;
  if (!modulusBase64Url) throw new Error('private key has no modulus');
  const modulus = BigInt(`0x${Buffer.from(modulusBase64Url, 'base64url').toString('hex')}`);
  const above = modulus + 1n;
  const hex = above.toString(16).padStart(256, '0');
  return Buffer.from(hex, 'hex');
};

const expectInvalidRequest = (fn: () => unknown): AppError => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe('INVALID_REQUEST');
    return appError;
  }
  throw new Error('expected the call to throw');
};

describe('decodeBase64', () => {
  it('decodes standard padded base64', () => {
    const bytes = randomBytes(128);
    expect(decodeBase64(bytes.toString('base64')).equals(bytes)).toBe(true);
  });

  it('rejects url-safe base64', () => {
    expectInvalidRequest(() => decodeBase64('abc-_def'));
  });

  it('rejects empty, whitespace-only and unpadded input', () => {
    expectInvalidRequest(() => decodeBase64(''));
    expectInvalidRequest(() => decodeBase64('   '));
    expectInvalidRequest(() => decodeBase64('AAAAA'));
  });

  it('rejects oversized payloads', () => {
    expectInvalidRequest(() => decodeBase64(randomBytes(1024).toString('base64')));
  });
});

describe('decryptRsaPkcs1', () => {
  let keys: { privateKey: KeyObject; publicKey: KeyObject };

  beforeAll(() => {
    keys = rsaPair();
  });

  it('recovers the 4-byte verify token the client encrypted', () => {
    const verifyToken = randomBytes(4);
    const plaintext = decryptRsaPkcs1(keys.privateKey, encrypt(keys.publicKey, verifyToken));

    expect(plaintext.equals(verifyToken)).toBe(true);
    expect(plaintext.length).toBe(4);
  });

  it('recovers the 16-byte shared secret', () => {
    const sharedSecret = randomBytes(16);
    const plaintext = decryptRsaPkcs1(keys.privateKey, encrypt(keys.publicKey, sharedSecret));

    expect(plaintext.equals(sharedSecret)).toBe(true);
  });

  it('rejects structurally impossible ciphertext with one generic error', () => {
    const tooShort = expectInvalidRequest(() => decryptRsaPkcs1(keys.privateKey, Buffer.alloc(0)));
    const tooLong = expectInvalidRequest(() =>
      decryptRsaPkcs1(keys.privateKey, Buffer.alloc(129, 0x41)),
    );
    const aboveModulus = expectInvalidRequest(() =>
      decryptRsaPkcs1(keys.privateKey, ciphertextAboveModulus(keys.privateKey)),
    );

    expect(tooShort.message).toBe(tooLong.message);
    expect(tooShort.message).toBe(aboveModulus.message);
  });

  // Node 24 / OpenSSL 3.x uses implicit rejection for PKCS#1 v1.5: bad padding
  // yields pseudo-random plaintext instead of an error. It *does* throw when the
  // ciphertext integer is >= the modulus, so both outcomes must be asserted
  // here; what matters is that the expected verify token never comes back.
  it('never yields the expected verify token for ciphertext from a foreign key', () => {
    const expected = randomBytes(4);
    const foreignKey = rsaPair();

    const ciphertext = encrypt(foreignKey.publicKey, expected);
    let decrypted: Buffer;
    try {
      decrypted = decryptRsaPkcs1(keys.privateKey, ciphertext);
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('INVALID_REQUEST');
      return;
    }

    expect(decrypted.equals(expected)).toBe(false);
    expect(safeEqual(decrypted, expected)).toBe(false);
  });

  it('never yields the expected verify token for tampered ciphertext', () => {
    const expected = randomBytes(4);
    const ciphertext = encrypt(keys.publicKey, expected);
    const tampered = Buffer.from(ciphertext);
    const lastIndex = tampered.length - 1;
    tampered.writeUInt8(tampered.readUInt8(lastIndex) ^ 0xff, lastIndex);

    let decrypted: Buffer;
    try {
      decrypted = decryptRsaPkcs1(keys.privateKey, tampered);
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      return;
    }
    expect(decrypted.equals(expected)).toBe(false);
  });
});

describe('safeEqual', () => {
  it('compares equal buffers as equal', () => {
    const token = randomBytes(4);
    expect(safeEqual(token, Buffer.from(token))).toBe(true);
  });

  it('detects a single differing bit', () => {
    const left = Buffer.from([1, 2, 3, 4]);
    const right = Buffer.from([1, 2, 3, 5]);
    expect(safeEqual(left, right)).toBe(false);
  });

  it('returns false for length mismatches without throwing', () => {
    expect(safeEqual(Buffer.from([1, 2, 3, 4]), Buffer.from([1, 2, 3]))).toBe(false);
    expect(safeEqual(Buffer.alloc(0), Buffer.alloc(0))).toBe(false);
  });
});
