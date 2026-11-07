import { jwtVerify, type JWTPayload } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Errors } from '../errors.js';
import { SessionModel, UserModel } from '../infrastructure/mongo/models/index.js';
import { bearerToken } from './auth.js';

export interface PortalAuthContext {
  accountId: string;
  username: string;
  sessionId: string;
  jti: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    portalAuth?: PortalAuthContext;
  }
}

/**
 * Verifies a portal token. Its audience is deliberately different from the
 * game API, so an account login can never be replayed against `/api/v1/users`
 * or the IRC server.
 */
export function authenticatePortal() {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const ctx = request.server.ctx;
    const token = bearerToken(request);
    if (!token) throw Errors.unauthorized('Authorization: Bearer <portal token> is required');

    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, ctx.keys.jwt.publicKey, {
        issuer: ctx.config.jwtIssuer,
        audience: ctx.config.portalJwtAudience,
        algorithms: ['EdDSA'],
      });
      payload = result.payload;
    } catch (error) {
      if (error instanceof Error && error.name === 'JWTExpired') throw Errors.tokenExpired();
      throw Errors.unauthorized('Portal token is invalid');
    }

    const accountId = payload.sub;
    const sessionId = payload.sid;
    if (typeof accountId !== 'string' || typeof sessionId !== 'string') {
      throw Errors.unauthorized('Portal token is missing required claims');
    }

    const user = await UserModel.findById(accountId).lean();
    if (!user) throw Errors.unauthorized('Account not found');
    if (user.status === 'banned') throw Errors.userBanned();

    if (await ctx.redis.exists(`auth:session:revoked:${sessionId}`)) {
      throw Errors.sessionRevoked();
    }

    const session = await SessionModel.findById(sessionId).lean();
    if (!session || String(session.userId) !== accountId || session.kind !== 'portal') {
      throw Errors.unauthorized('Portal session not found');
    }
    if (session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
      throw Errors.sessionRevoked();
    }

    request.portalAuth = {
      accountId,
      username: user.username,
      sessionId,
      jti: String(payload.jti ?? ''),
    };
  };
}

export function currentPortalAuth(request: FastifyRequest): PortalAuthContext {
  if (!request.portalAuth) throw Errors.unauthorized('Portal authentication required');
  return request.portalAuth;
}
