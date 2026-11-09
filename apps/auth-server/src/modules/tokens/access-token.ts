import { randomUUID } from 'node:crypto';
import { SignJWT, type JWTPayload } from 'jose';
import type { Scope } from '@hotaru/shared-types';
import type { JwtKeys } from '../../infrastructure/crypto/keys.js';

export interface AccessTokenInput {
  /** Internal user id (Mongo `_id`). Never the Mojang UUID. */
  userId: string;
  minecraftUuid: string;
  sessionId: string;
  scopes: readonly Scope[];
  issuer: string;
  audience: string;
  ttlSeconds: number;
  clientId?: string | null;
  clientVersion?: string | null;
  clientKeyId?: string | null;
  /** Injectable clock (epoch seconds) so tests can pin `iat`/`exp`. */
  nowSeconds?: number;
}

export interface SignedAccessToken {
  token: string;
  jti: string;
  expiresAt: Date;
  expiresIn: number;
}

/** Custom claims, mirrored from `AccessTokenClaims` in @hotaru/shared-types. */
type AccessTokenPayload = JWTPayload & {
  minecraft_uuid: string;
  sid: string;
  scope: string;
  client_id?: string;
  client_version?: string;
  client_key_id?: string;
};

/**
 * Signs an Ed25519 (EdDSA) access token.
 *
 * `sub` is the internal user id, `minecraft_uuid` is the Mojang identity and
 * `sid` points at the session so revocation can be checked on every request.
 * `scope` is the space-joined grant list *as known at issue time*; the auth
 * plugin recomputes effective scopes from MongoDB, so this claim is never
 * authoritative.
 */
export async function signAccessToken(
  keys: JwtKeys,
  input: AccessTokenInput,
): Promise<SignedAccessToken> {
  const issuedAt = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const expiresAtSeconds = issuedAt + input.ttlSeconds;
  const jti = randomUUID();

  const payload: AccessTokenPayload = {
    minecraft_uuid: input.minecraftUuid,
    sid: input.sessionId,
    scope: input.scopes.join(' '),
    ...(input.clientId ? { client_id: input.clientId } : {}),
    ...(input.clientVersion ? { client_version: input.clientVersion } : {}),
    ...(input.clientKeyId ? { client_key_id: input.clientKeyId } : {}),
  };

  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: keys.alg, kid: keys.kid, typ: 'JWT' })
    .setIssuer(input.issuer)
    .setSubject(input.userId)
    .setAudience([input.audience])
    .setJti(jti)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAtSeconds)
    .sign(keys.privateKey);

  return {
    token,
    jti,
    expiresAt: new Date(expiresAtSeconds * 1000),
    expiresIn: input.ttlSeconds,
  };
}
