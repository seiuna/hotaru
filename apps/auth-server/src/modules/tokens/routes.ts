import { decodeJwt } from 'jose';
import { Types } from 'mongoose';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { refreshRequestSchema, tokenResponseSchema } from '@skymatrix/api-contract';
import type { AppContext } from '../../context.js';
import { Errors } from '../../errors.js';
import { clientIp, toJsonSchema, userAgentOf } from '../../http/zod-schema.js';
import { authenticate, bearerToken } from '../../plugins/auth.js';
import { revokeSession, rotateRefreshToken, type SessionRequestMeta } from './service.js';

function requestMeta(request: FastifyRequest): SessionRequestMeta {
  return {
    ip: clientIp(request.headers, request.ip),
    userAgent: userAgentOf(request.headers),
  };
}

/**
 * `/api/v1/auth/refresh` and `/api/v1/auth/logout`.
 *
 * Refresh is unauthenticated by design: the opaque refresh token *is* the
 * credential and is rotated on every use. Logout requires a live access token
 * so an attacker cannot kill sessions with a guessed id.
 */
export async function registerTokenRoutes(app: FastifyInstance, _ctx: AppContext): Promise<void> {
  app.post<{ Body: unknown }>(
    '/api/v1/auth/refresh',
    {
      schema: {
        tags: ['auth'],
        summary: 'Rotate a refresh token and issue a new access token',
        body: toJsonSchema(refreshRequestSchema),
        response: { 200: toJsonSchema(tokenResponseSchema) },
      },
    },
    async (request) => {
      const ctx = request.server.ctx;
      const body = refreshRequestSchema.parse(request.body);
      return rotateRefreshToken(ctx, body.refreshToken, requestMeta(request));
    },
  );

  app.post(
    '/api/v1/auth/logout',
    {
      preHandler: authenticate(),
      schema: {
        tags: ['auth'],
        summary: 'Revoke the current session (access + refresh tokens)',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const ctx = request.server.ctx;
      const auth = request.auth;
      if (!auth) throw Errors.unauthorized();

      // The guard already verified the signature; `exp` is only used to size
      // the Redis revocation key, and the DB check enforces revocation anyway.
      let accessTokenExpiresAt: Date | null = null;
      const token = bearerToken(request);
      if (token) {
        try {
          const payload = decodeJwt(token);
          if (typeof payload.exp === 'number') accessTokenExpiresAt = new Date(payload.exp * 1000);
        } catch {
          accessTokenExpiresAt = null;
        }
      }

      await revokeSession(ctx, {
        sessionId: new Types.ObjectId(auth.sessionId),
        reason: 'user_logout',
        accessTokenExpiresAt,
        meta: requestMeta(request),
      });

      reply.status(204).send();
    },
  );
}
