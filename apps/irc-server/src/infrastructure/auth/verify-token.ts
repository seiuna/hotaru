import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { AppContext } from '../../context.js';
import { REQUIRED_SCOPE, sessionRevokedKey } from '@hotaru/srp-protocol';
import { SRP_ERROR_CODES, type SrpErrorCode } from '@hotaru/srp-protocol';

export interface VerifiedIdentity {
  userId: string;
  minecraftUuid: string;
  sessionId: string;
  scopes: string[];
  expiresAt: number;
  raw: JWTPayload;
}

/**
 * Auth failures carry an SRP code so both the WebSocket upgrade and REST routes
 * can answer consistently (`401`/`403` with `error.code`).
 */
export class AuthError extends Error {
  readonly code: SrpErrorCode;
  readonly statusCode: number;

  constructor(code: SrpErrorCode, message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.statusCode =
      code === 'SCOPE_DENIED' || code === 'SESSION_REVOKED' ? 403 : 401;
  }
}

/** One remote key set per JWKS URL, cached by jose (with cooldown). */
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function keySetFor(url: string): ReturnType<typeof createRemoteJWKSet> {
  const existing = keySets.get(url);
  if (existing) return existing;
  const created = createRemoteJWKSet(new URL(url), {
    cacheMaxAge: 600_000,
    cooldownDuration: 5_000,
  });
  keySets.set(url, created);
  return created;
}

/**
 * Verifies an access token end to end:
 *
 * 1. Ed25519 signature against the auth server's JWKS (`aud`/`iss`/`exp` enforced);
 * 2. `hotaru:ircserver` present;
 * 3. session not revoked — checked against the Redis key the auth server writes,
 *    which is what makes a logout/ban take effect before the token expires.
 */
export async function verifyAccessToken(ctx: AppContext, token: string): Promise<VerifiedIdentity> {
  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, keySetFor(ctx.config.authJwksUrl), {
      issuer: ctx.config.jwtIssuer,
      audience: ctx.config.jwtAudience,
      algorithms: ['EdDSA'],
    });
    payload = result.payload;
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'JWTExpired') throw new AuthError('TOKEN_EXPIRED', 'Access token has expired');
    throw new AuthError('UNAUTHORIZED', 'Access token is invalid');
  }

  const userId = payload.sub;
  const sessionId = payload.sid;
  const minecraftUuid = payload.minecraft_uuid;
  if (typeof userId !== 'string' || typeof sessionId !== 'string' || typeof minecraftUuid !== 'string') {
    throw new AuthError('UNAUTHORIZED', 'Access token is missing required claims');
  }

  const scopeClaim = typeof payload.scope === 'string' ? payload.scope : '';
  const scopes = scopeClaim.split(' ').filter(Boolean);
  if (!scopes.includes(REQUIRED_SCOPE)) {
    throw new AuthError('SCOPE_DENIED', `Missing scope ${REQUIRED_SCOPE}`);
  }

  // Shared Redis with the auth server: revocation is immediate, not TTL-bound.
  try {
    if (await ctx.redis.exists(sessionRevokedKey(sessionId))) {
      throw new AuthError('SESSION_REVOKED', 'Session has been revoked');
    }
  } catch (error) {
    if (error instanceof AuthError) throw error;
    // Redis down: fail closed for a security decision.
    throw new AuthError('UNAUTHORIZED', 'Cannot verify session state right now');
  }

  return {
    userId,
    minecraftUuid: minecraftUuid.toLowerCase(),
    sessionId,
    scopes,
    expiresAt: typeof payload.exp === 'number' ? payload.exp : 0,
    raw: payload,
  };
}

export { SRP_ERROR_CODES };
