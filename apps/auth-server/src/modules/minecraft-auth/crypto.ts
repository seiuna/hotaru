import { constants, privateDecrypt, timingSafeEqual, type KeyObject } from 'node:crypto';
import { Errors } from '../../errors.js';

/** RSA-1024 ciphertext is 128 bytes; anything much larger is not a valid payload. */
const MAX_CIPHERTEXT_BYTES = 512;

/** Vanilla clients send standard, padded base64 — never base64url. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** Single error used for *every* cryptographic failure in the verify endpoint. */
function invalidEncryptedPayload(): Error {
  return Errors.invalidRequest('Encrypted payload could not be processed');
}

/** Strict base64 decode: rejects url-safe alphabets, whitespace and empty input. */
export function decodeBase64(value: string): Buffer {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length % 4 !== 0 || !BASE64_PATTERN.test(trimmed)) {
    throw invalidEncryptedPayload();
  }
  const buffer = Buffer.from(trimmed, 'base64');
  if (buffer.length === 0 || buffer.length > MAX_CIPHERTEXT_BYTES) throw invalidEncryptedPayload();
  return buffer;
}

/**
 * Decrypts a value the Minecraft client encrypted with our RSA public key using
 * PKCS#1 v1.5 padding.
 *
 * SECURITY NOTE: Node 24 / OpenSSL 3.x applies *implicit rejection* to RSA
 * PKCS#1 v1.5 decryption — invalid padding does not raise, it produces
 * pseudo-random plaintext ("error:data too small"/"greater than mod len" are
 * still raised for impossible lengths). No caller may therefore treat a
 * successful decrypt as authenticating the payload: the verify-token byte
 * comparison and the fixed shared-secret length are the real gates, and a
 * garbage decrypt fails those with the same generic INVALID_REQUEST as a
 * decrypt error.
 */
export function decryptRsaPkcs1(privateKey: KeyObject, ciphertext: Buffer): Buffer {
  try {
    const plaintext = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
      ciphertext,
    );
    if (plaintext.length === 0) throw new Error('empty plaintext');
    return plaintext;
  } catch {
    throw invalidEncryptedPayload();
  }
}

/**
 * Constant-time buffer comparison. `timingSafeEqual` throws on length mismatch,
 * so lengths are compared first; that only reveals a length, never content.
 */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
