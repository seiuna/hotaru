import { randomUUID } from 'node:crypto';
import { SignJWT, type JWTPayload } from 'jose';
import { PORTAL_SCOPES, type PortalScope } from '@hotaru/shared-types';
import type { JwtKeys } from '../../infrastructure/crypto/keys.js';

export interface PortalTokenInput {
  accountId: string;
  sessionId: string;
  issuer: string;
  audience: string;
  ttlSeconds: number;
  nowSeconds?: number;
}

export interface SignedPortalToken {
  token: string;
  jti: string;
  expiresAt: Date;
  expiresIn: number;
}

type PortalTokenPayload = JWTPayload & {
  sid: string;
  scope: string;
};

export async function signPortalToken(
  keys: JwtKeys,
  input: PortalTokenInput,
): Promise<SignedPortalToken> {
  const issuedAt = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const expiresAtSeconds = issuedAt + input.ttlSeconds;
  const jti = randomUUID();
  const scopes: PortalScope[] = [...PORTAL_SCOPES];
  const payload: PortalTokenPayload = {
    sid: input.sessionId,
    scope: scopes.join(' '),
  };

  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: keys.alg, kid: keys.kid, typ: 'JWT' })
    .setIssuer(input.issuer)
    .setSubject(input.accountId)
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
