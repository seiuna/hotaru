import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  adminBanSchema,
  adminLinkBanResponseSchema,
  adminListUsersQuerySchema,
  adminListUsersResponseSchema,
  adminRevokeSessionSchema,
  adminSetPermissionsSchema,
  adminStatsResponseSchema,
  adminUserDetailResponseSchema,
  adminUserSessionsQuerySchema,
  adminUserSessionsResponseSchema,
  auditListQuerySchema,
  errorResponseSchema,
  minecraftUuidSchema,
  objectIdSchema,
  permissionsResponseSchema,
} from '@hotaru/api-contract';
import type { AppContext } from '../../context.js';
import { Errors } from '../../errors.js';
import { clientIp, toJsonSchema } from '../../http/zod-schema.js';
import { authenticate } from '../../plugins/auth.js';
import { currentAuth } from '../users/service.js';
import {
  auditLogListResponseSchema,
  adminBanResponseSchema,
  adminRevokeSessionResponseSchema,
  adminUnbanResponseSchema,
} from './schemas.js';
import {
  adminStats,
  banMinecraftLink,
  banUser,
  getUserDetail,
  listAuditLogs,
  listUserSessions,
  listUsers,
  redisRevocationStore,
  replacePermissions,
  revokeSession,
  unbanMinecraftLink,
  unbanUser,
  type AdminActor,
  type AdminDeps,
} from './service.js';

const idParamsSchema = z.object({ id: objectIdSchema });
const linkParamsSchema = z.object({ id: objectIdSchema, uuid: minecraftUuidSchema });

const errorResponses = {
  400: toJsonSchema(errorResponseSchema),
  401: toJsonSchema(errorResponseSchema),
  403: toJsonSchema(errorResponseSchema),
  404: toJsonSchema(errorResponseSchema),
} as const;

/**
 * A malformed id can never identify a stored document, so it reports the same
 * 404 as an unknown id instead of leaking the difference between "invalid" and
 * "does not exist".
 */
function idParam(params: unknown, what: string): string {
  const parsed = idParamsSchema.safeParse(params);
  if (!parsed.success) throw Errors.notFound(what);
  return parsed.data.id;
}

function linkParams(params: unknown): { id: string; uuid: string } {
  const parsed = linkParamsSchema.safeParse(params);
  if (!parsed.success) throw Errors.notFound('Minecraft link');
  return parsed.data;
}

function actorOf(request: FastifyRequest): AdminActor {
  const auth = currentAuth(request);
  return { userId: auth.userId, ip: clientIp(request.headers as Record<string, unknown>, request.ip) };
}

/**
 * Administration endpoints. Every route is scope-guarded by `admin:users`,
 * which the auth plugin recomputes from MongoDB on each request — revoking the
 * scope therefore locks the admin out on their next call, not at token expiry.
 */
export async function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const deps: AdminDeps = { ctx, store: redisRevocationStore(ctx.redis) };
  const guard = authenticate({ scopes: ['admin:users'] });

  app.get(
    '/api/v1/admin/users',
    {
      schema: {
        tags: ['admin'],
        summary: 'Search users by username substring or Minecraft-UUID prefix',
        security: [{ bearerAuth: [] }],
        querystring: toJsonSchema(adminListUsersQuerySchema),
        response: {
          200: toJsonSchema(adminListUsersResponseSchema),
          401: errorResponses[401],
          403: errorResponses[403],
        },
      },
      preHandler: guard,
    },
    async (request) => {
      const query = adminListUsersQuerySchema.parse(request.query);
      return listUsers({
        query: query.query,
        status: query.status,
        limit: query.limit,
        offset: query.offset,
      });
    },
  );

  app.put(
    '/api/v1/admin/users/:id/permissions',
    {
      schema: {
        tags: ['admin'],
        summary: 'Replace the permission grants of a user',
        security: [{ bearerAuth: [] }],
        body: toJsonSchema(adminSetPermissionsSchema),
        response: {
          200: toJsonSchema(permissionsResponseSchema),
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          404: errorResponses[404],
        },
      },
      preHandler: guard,
    },
    async (request) => {
      const userId = idParam(request.params, 'User');
      const body = adminSetPermissionsSchema.parse(request.body);
      return replacePermissions(deps, actorOf(request), userId, body.permissions);
    },
  );

  app.post(
    '/api/v1/admin/users/:id/ban',
    {
      schema: {
        tags: ['admin'],
        summary: 'Ban a user and revoke all of their active sessions',
        security: [{ bearerAuth: [] }],
        body: toJsonSchema(adminBanSchema),
        response: {
          200: toJsonSchema(adminBanResponseSchema),
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          404: errorResponses[404],
        },
      },
      preHandler: guard,
    },
    async (request) => {
      const userId = idParam(request.params, 'User');
      const body = adminBanSchema.parse(request.body ?? {});
      return banUser(deps, actorOf(request), userId, body.reason ?? null);
    },
  );

  app.post(
    '/api/v1/admin/users/:id/unban',
    {
      schema: {
        tags: ['admin'],
        summary: 'Lift a ban (sessions revoked by the ban stay revoked)',
        security: [{ bearerAuth: [] }],
        response: {
          200: toJsonSchema(adminUnbanResponseSchema),
          401: errorResponses[401],
          403: errorResponses[403],
          404: errorResponses[404],
        },
      },
      preHandler: guard,
    },
    async (request) => {
      const userId = idParam(request.params, 'User');
      return unbanUser(deps, actorOf(request), userId);
    },
  );

  app.post(
    '/api/v1/admin/users/:id/links/:uuid/ban',
    {
      schema: {
        tags: ['admin'],
        summary: 'Ban one linked Minecraft identity and revoke its sessions',
        security: [{ bearerAuth: [] }],
        body: toJsonSchema(adminBanSchema),
        response: {
          200: toJsonSchema(adminLinkBanResponseSchema),
          401: errorResponses[401],
          403: errorResponses[403],
          404: errorResponses[404],
        },
      },
      preHandler: guard,
    },
    async (request) => {
      const { id, uuid } = linkParams(request.params);
      const body = adminBanSchema.parse(request.body ?? {});
      return banMinecraftLink(deps, actorOf(request), id, uuid, body.reason ?? null);
    },
  );

  app.post(
    '/api/v1/admin/users/:id/links/:uuid/unban',
    {
      schema: {
        tags: ['admin'],
        summary: 'Lift a ban on one linked Minecraft identity',
        security: [{ bearerAuth: [] }],
        response: {
          200: toJsonSchema(adminLinkBanResponseSchema),
          401: errorResponses[401],
          403: errorResponses[403],
          404: errorResponses[404],
        },
      },
      preHandler: guard,
    },
    async (request) => {
      const { id, uuid } = linkParams(request.params);
      return { ...(await unbanMinecraftLink(deps, actorOf(request), id, uuid)), sessionsRevoked: 0 };
    },
  );

  app.post(
    '/api/v1/admin/sessions/:id/revoke',
    {
      schema: {
        tags: ['admin'],
        summary: 'Revoke a single session (MongoDB + Redis revocation key)',
        security: [{ bearerAuth: [] }],
        body: toJsonSchema(adminRevokeSessionSchema),
        response: {
          200: toJsonSchema(adminRevokeSessionResponseSchema),
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          404: errorResponses[404],
        },
      },
      preHandler: guard,
    },
    async (request) => {
      const sessionId = idParam(request.params, 'Session');
      const body = adminRevokeSessionSchema.parse(request.body ?? {});
      return revokeSession(deps, actorOf(request), sessionId, body.reason ?? null);
    },
  );

  app.get(
    '/api/v1/admin/users/:id',
    {
      schema: {
        tags: ['admin'],
        summary: 'One user with their permission grants',
        security: [{ bearerAuth: [] }],
        response: {
          200: toJsonSchema(adminUserDetailResponseSchema),
          401: errorResponses[401],
          403: errorResponses[403],
          404: errorResponses[404],
        },
      },
      preHandler: guard,
    },
    async (request) => getUserDetail(idParam(request.params, 'User')),
  );

  app.get(
    '/api/v1/admin/stats',
    {
      schema: {
        tags: ['admin'],
        summary: 'Dashboard counters (users, active sessions, grants, 24h audit events)',
        security: [{ bearerAuth: [] }],
        response: {
          200: toJsonSchema(adminStatsResponseSchema),
          401: errorResponses[401],
          403: errorResponses[403],
        },
      },
      preHandler: guard,
    },
    async () => adminStats(),
  );

  app.get(
    '/api/v1/admin/users/:id/sessions',
    {
      schema: {
        tags: ['admin'],
        summary: 'Sessions of one user, newest first',
        security: [{ bearerAuth: [] }],
        querystring: toJsonSchema(adminUserSessionsQuerySchema),
        response: {
          200: toJsonSchema(adminUserSessionsResponseSchema),
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          404: errorResponses[404],
        },
      },
      preHandler: guard,
    },
    async (request) => {
      const userId = idParam(request.params, 'User');
      const query = adminUserSessionsQuerySchema.parse(request.query);
      return listUserSessions({
        userId,
        limit: query.limit,
        offset: query.offset,
        includeRevoked: query.includeRevoked,
      });
    },
  );

  app.get(
    '/api/v1/admin/audit-logs',
    {
      schema: {
        tags: ['admin'],
        summary: 'Audit log, newest first, filtered by event and actor',
        security: [{ bearerAuth: [] }],
        querystring: toJsonSchema(auditListQuerySchema),
        response: {
          200: toJsonSchema(auditLogListResponseSchema),
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
        },
      },
      preHandler: guard,
    },
    async (request) => {
      const query = auditListQuerySchema.parse(request.query);
      return listAuditLogs({
        event: query.event,
        actorId: query.actorId,
        limit: query.limit,
        offset: query.offset,
      });
    },
  );
}
