import { jwtVerify, type JWTPayload } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Scope } from '@skymatrix/shared-types';
import { Errors } from '../errors.js';
import { SessionModel, UserModel, PermissionModel } from '../infrastructure/mongo/models/index.js';

export interface AuthContext {
  userId: string;
  minecraftUuid: string;
  username: string;
  sessionId: string;
  jti: string;
  /** Effective scopes from MongoDB — never the token's claims. */
  scopes: Scope[];
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export const revocationKey = (sessionId: string): string => `auth:session:revoked:${sessionId}`;

export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
  return token.trim();
}

/**
 * Verifies the Ed25519 access token, then re-derives authority from the
 * database: revocation, ban status and scopes are all live checks, so a ban or
 * permission change takes effect on the next request instead of at token expiry.
 */
export function authenticate(options: { scopes?: Scope[] } = {}) {
  const required = options.scopes ?? [];

  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const ctx = request.server.ctx;
    const token = bearerToken(request);
    if (!token) throw Errors.unauthorized('Authorization: Bearer <access token> is required');

    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, ctx.keys.jwt.publicKey, {
        issuer: ctx.config.jwtIssuer,
        audience: ctx.config.jwtAudience,
        algorithms: ['EdDSA'],
      });
      payload = result.payload;
    } catch (error) {
      if (error instanceof Error && error.name === 'JWTExpired') throw Errors.tokenExpired();
      throw Errors.unauthorized('Access token is invalid');
    }

    const userId = payload.sub;
    const sessionId = payload.sid;
    if (typeof userId !== 'string' || typeof sessionId !== 'string') {
      throw Errors.unauthorized('Access token is missing required claims');
    }

    // Account-level state is checked before session-level state: a ban revokes the
    // user's sessions as a side effect, and if revocation were checked first every
    // banned token would surface as a generic 401 SESSION_REVOKED. Clients need the
    // actionable code (403 USER_BANNED) instead of a "log in again" prompt.
    const user = await UserModel.findById(userId).lean();
    if (!user) throw Errors.unauthorized('User not found');
    if (user.status === 'banned') throw Errors.userBanned();

    if (await ctx.redis.exists(revocationKey(sessionId))) {
      throw Errors.sessionRevoked();
    }

    const session = await SessionModel.findById(sessionId).lean();
    if (!session || String(session.userId) !== userId) throw Errors.unauthorized('Session not found');
    if (session.revokedAt) throw Errors.sessionRevoked();
    if (session.expiresAt.getTime() <= Date.now()) throw Errors.sessionRevoked();

    const now = new Date();
    const permissions = await PermissionModel.find({
      userId: user._id,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
    })
      .select({ scope: 1 })
      .lean();
    const scopes = permissions.map((p) => p.scope as Scope);

    const missing = required.filter((scope) => !scopes.includes(scope));
    if (missing.length > 0) throw Errors.forbidden(`Missing scope: ${missing.join(', ')}`);

    request.auth = {
      userId,
      minecraftUuid: user.minecraftUuid,
      username: user.username,
      sessionId,
      jti: String(payload.jti ?? ''),
      scopes,
    };
  };
}
