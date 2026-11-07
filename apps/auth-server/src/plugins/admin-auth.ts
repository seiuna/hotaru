import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Scope } from '@hotaru/shared-types';
import { AppError, Errors } from '../errors.js';
import { authenticate, type AuthContext } from './auth.js';
import { authenticatePortal, currentPortalAuth } from './portal.js';
import { UserModel } from '../infrastructure/mongo/models/index.js';
import { effectiveScopes, loadPermissionViews } from '../modules/users/service.js';

/**
 * Admin routes accept either a Minecraft access token or a portal token from
 * the password console. The portal branch re-derives `admin:users` from
 * MongoDB, so a revoked scope takes effect on the next request just like the
 * game-token branch.
 */
export function authenticateAdmin(options: { scopes?: Scope[] } = {}) {
  const gameGuard = authenticate(options);
  const portalGuard = authenticatePortal();

  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      await gameGuard(request, reply);
      return;
    } catch (error) {
      // A portal token has a different audience, so the game guard reports
      // UNAUTHORIZED. Fall through only in that case; a real scope failure or
      // expired game token must stay a hard failure.
      if (!(error instanceof AppError) || error.code !== 'UNAUTHORIZED') throw error;
    }

    await portalGuard(request, reply);
    const portal = currentPortalAuth(request);
    const user = await UserModel.findById(portal.accountId).lean();
    if (!user) throw Errors.unauthorized('Account not found');
    if (user.status === 'banned') throw Errors.userBanned();

    const scopes = effectiveScopes(await loadPermissionViews(portal.accountId));
    const required = options.scopes ?? [];
    if (required.some((scope) => !scopes.includes(scope))) {
      throw Errors.forbidden(`This action requires ${required.join(', ')}`);
    }

    const auth: AuthContext = {
      userId: portal.accountId,
      minecraftUuid: user.minecraftUuid ?? '',
      username: user.username,
      sessionId: portal.sessionId,
      jti: portal.jti,
      scopes,
    };
    request.auth = auth;
  };
}
