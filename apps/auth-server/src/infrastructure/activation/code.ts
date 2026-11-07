import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AppConfig } from '../../config/env.js';

export type ActivationType = 'account' | 'bind';

export interface ActivationPayload {
  v: 1;
  type: ActivationType;
  jti: string;
  exp: number;
  /** Required for bind codes. */
  uuid?: string;
  /** Display name stored on the Minecraft link. */
  username?: string;
}

export class ActivationCodeError extends Error {
  readonly reason: 'invalid' | 'expired' | 'type';

  constructor(reason: 'invalid' | 'expired' | 'type', message: string) {
    super(message);
    this.name = 'ActivationCodeError';
    this.reason = reason;
  }
}

const publicKeyCache = new Map<string, KeyObject>();

export async function loadActivationPublicKey(config: AppConfig): Promise<KeyObject | null> {
  if (config.activationPublicKeyPem) {
    const key = createPublicKey(config.activationPublicKeyPem);
    publicKeyCache.set(config.activationPublicKeyPem, key);
    return key;
  }
  if (config.activationPublicKeyFile) {
    const cached = publicKeyCache.get(config.activationPublicKeyFile);
    if (cached) return cached;
    const pem = await readFile(config.activationPublicKeyFile, 'utf8');
    const key = createPublicKey(pem);
    publicKeyCache.set(config.activationPublicKeyFile, key);
    return key;
  }
  return null;
}

function decodeSegment(segment: string): Buffer {
  try {
    return Buffer.from(segment, 'base64url');
  } catch {
    throw new ActivationCodeError('invalid', 'activation code is not valid base64url');
  }
}

export function verifyActivationCode(
  code: string,
  publicKey: KeyObject,
  nowMs: number = Date.now(),
): ActivationPayload {
  const segments = code.trim().split('.');
  if (segments.length !== 2) throw new ActivationCodeError('invalid', 'activation code is malformed');
  const [payloadSegment, signatureSegment] = segments;
  if (!payloadSegment || !signatureSegment) {
    throw new ActivationCodeError('invalid', 'activation code is malformed');
  }
  const payloadBytes = decodeSegment(payloadSegment);
  const signature = decodeSegment(signatureSegment);
  const valid = verify(null, payloadBytes, publicKey, signature);
  if (!valid) throw new ActivationCodeError('invalid', 'activation code signature is invalid');

  let payload: unknown;
  try {
    payload = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    throw new ActivationCodeError('invalid', 'activation code payload is not JSON');
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new ActivationCodeError('invalid', 'activation code payload is invalid');
  }
  const value = payload as Record<string, unknown>;
  if (value.v !== 1 || (value.type !== 'account' && value.type !== 'bind')) {
    throw new ActivationCodeError('type', 'activation code type is unsupported');
  }
  if (typeof value.jti !== 'string' || !value.jti) {
    throw new ActivationCodeError('invalid', 'activation code id is missing');
  }
  if (typeof value.exp !== 'number' || !Number.isFinite(value.exp)) {
    throw new ActivationCodeError('invalid', 'activation code expiry is missing');
  }
  if (typeof value.uuid !== 'undefined' && typeof value.uuid !== 'string') {
    throw new ActivationCodeError('invalid', 'activation code UUID is invalid');
  }
  if (typeof value.username !== 'undefined' && typeof value.username !== 'string') {
    throw new ActivationCodeError('invalid', 'activation code username is invalid');
  }
  if (value.type === 'bind') {
    if (typeof value.uuid !== 'string' || !value.uuid) {
      throw new ActivationCodeError('invalid', 'bind activation code has no UUID');
    }
  }
  if (value.exp <= Math.floor(nowMs / 1000)) {
    throw new ActivationCodeError('expired', 'activation code has expired');
  }
  return value as unknown as ActivationPayload;
}

export function signActivationCode(payload: ActivationPayload, privateKeyPem: string): string {
  const privateKey = createPrivateKey(privateKeyPem);
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = sign(null, payloadBytes, privateKey);
  return `${payloadBytes.toString('base64url')}.${signature.toString('base64url')}`;
}
