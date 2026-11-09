import { createHash, createPublicKey } from 'node:crypto';

export interface ClientKeyConfig {
  /** Base64 DER (SubjectPublicKeyInfo) of the approved Ed25519/ECDSA/RSA key. */
  publicKey: string;
  /** SHA-256 hex of the DER bytes. */
  keyId: string;
}

export function normalizeClientPublicKey(input: string): ClientKeyConfig {
  const text = input.trim();
  let der: Buffer;
  try {
    if (text.includes('BEGIN PUBLIC KEY')) {
      const key = createPublicKey(text);
      der = Buffer.from(key.export({ type: 'spki', format: 'der' }));
    } else {
      der = Buffer.from(text.replace(/\s+/g, ''), 'base64');
      createPublicKey({ key: der, format: 'der', type: 'spki' });
    }
  } catch {
    throw new Error('client public key is not a valid SPKI PEM or base64 DER key');
  }
  return {
    publicKey: der.toString('base64'),
    keyId: createHash('sha256').update(der).digest('hex'),
  };
}

/**
 * CLIENT_KEYS is a JSON object: {"official-mod":"<public key>","test-mod":"<public key>"}.
 * Values may be PEM or base64 DER. The map is normalized once at startup.
 */
export function parseClientKeys(raw: string | undefined): Record<string, ClientKeyConfig> {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('CLIENT_KEYS must be a JSON object');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('CLIENT_KEYS must be a JSON object');
  }
  const result: Record<string, ClientKeyConfig> = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      throw new Error(`CLIENT_KEYS["${id}"] must be a public key string`);
    }
    result[id] = normalizeClientPublicKey(value);
  }
  return result;
}
