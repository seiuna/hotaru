import type { FastifyInstance } from 'fastify';
import { errorResponseSchema, meResponseSchema, permissionsResponseSchema } from '@hotaru/api-contract';
import type { AppContext } from '../../context.js';
import { Errors } from '../../errors.js';
import { toJsonSchema } from '../../http/zod-schema.js';
import { authenticate } from '../../plugins/auth.js';
import {
  currentAuth,
  effectiveScopes,
  getUserView,
  loadPermissionViews,
} from './service.js';

/**
 * Self-service endpoints. Both are guarded by any valid access token: the guard
 * already reloads the user and recomputes scopes from MongoDB on every request,
 * so these handlers only map the database state to the wire format.
 */
export async function registerUserRoutes(app: FastifyInstance, _ctx: AppContext): Promise<void> {
  const guard = authenticate();

  app.get(
    '/api/v1/users/me',
    {
      schema: {
        tags: ['users'],
        summary: 'Profile of the authenticated user with their effective scopes',
        security: [{ bearerAuth: [] }],
        response: {
          200: toJsonSchema(meResponseSchema),
          401: toJsonSchema(errorResponseSchema),
        },
      },
      preHandler: guard,
    },
    async (request) => {
      const auth = currentAuth(request);
      const user = await getUserView(auth.userId);
      // The guard just loaded this document; a miss here means it was deleted
      // between the guard and the handler, so fail closed rather than lie.
      if (!user) throw Errors.unauthorized('User not found');
      return { user, scopes: auth.scopes };
    },
  );

  app.get(
    '/api/v1/users/me/permissions',
    {
      schema: {
        tags: ['users'],
        summary: 'All permission grants of the authenticated user and their effective scopes',
        security: [{ bearerAuth: [] }],
        response: {
          200: toJsonSchema(permissionsResponseSchema),
          401: toJsonSchema(errorResponseSchema),
        },
      },
      preHandler: guard,
    },
    async (request) => {
      const auth = currentAuth(request);
      const permissions = await loadPermissionViews(auth.userId);
      // Expired grants stay visible (they are still auditable) but never count
      // as effective authority.
      return { permissions, scopes: effectiveScopes(permissions) };
    },
  );
}
