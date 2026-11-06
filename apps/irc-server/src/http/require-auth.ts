import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from './app-error.js';
import type { AppContext } from '../context.js';
import { verifyAccessToken } from '../infrastructure/auth/verify-token.js';

export interface AuthContext {
  /** Internal user id (JWT `sub`). */
  userId: string;
  /** Mojang UUID, dashed lowercase — the identity used by groups/presence. */
  minecraftUuid: string;
  sessionId: string;
  scopes: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
  return token.trim();
}

/**
 * `preHandler` factory for REST routes. Same verification path as the WebSocket
 * upgrade, so a token that can open a socket can also read the REST API (and
 * vice versa) — one identity model, not two.
 */
export function requireAuth(ctx: AppContext) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const token = bearerToken(request);
    if (!token) throw new AppError('UNAUTHORIZED', 'Authorization: Bearer <token> is required');

    const identity = await verifyAccessToken(ctx, token);
    request.auth = {
      userId: identity.userId,
      minecraftUuid: identity.minecraftUuid,
      sessionId: identity.sessionId,
      scopes: identity.scopes,
    };
  };
}

/** Non-throwing variant: attaches `request.auth` when a valid token is present. */
export function optionalAuth(ctx: AppContext) {
  return async (request: FastifyRequest): Promise<void> => {
    const token = bearerToken(request);
    if (!token) return;
    try {
      const identity = await verifyAccessToken(ctx, token);
      request.auth = {
        userId: identity.userId,
        minecraftUuid: identity.minecraftUuid,
        sessionId: identity.sessionId,
        scopes: identity.scopes,
      };
    } catch {
      // Public endpoints ignore bad credentials instead of failing.
    }
  };
}

/** Narrowed accessor for handlers that run behind `requireAuth`. */
export function currentAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new AppError('UNAUTHORIZED', 'Authentication required');
  return request.auth;
}
