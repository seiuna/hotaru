import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { AppError } from '../../http/app-error.js';
import { currentAuth, requireAuth } from '../../http/require-auth.js';
import { clientIp, toJsonSchema } from '../../http/zod-schema.js';
import type {
  AuditService,
  FilterService,
  GroupMembership,
  GroupService,
} from '../../runtime/contracts.js';
import { createAuditService } from '../audit/service.js';
import { createGroupService } from '../groups/service.js';
import { MAX_RULES_PER_SCOPE, isAdminUuid } from './engine.js';

/* ------------------------------------------------------------------ */
/* Wire schemas                                                       */
/* ------------------------------------------------------------------ */

const filterScopeSchema = z.enum(['GLOBAL', 'GROUP', 'USER']);
const filterActionSchema = z.enum(['ALLOW', 'DENY']);

export const filterRuleSchema = z.object({
  id: z.string(),
  scope: filterScopeSchema,
  targetId: z.string().nullable(),
  pattern: z.string(),
  action: filterActionSchema,
  enabled: z.boolean(),
  createdAt: z.string(),
});

export const rulesResponseSchema = z.object({ rules: z.array(filterRuleSchema) });

export const replaceRulesBodySchema = z.object({
  /**
   * The complete rule set for the scope. Replaces whatever is stored: PUT is
   * idempotent, and omitting a rule is how you delete it.
   */
  rules: z
    .array(
      z.object({
        pattern: z.string().min(1).max(128),
        action: filterActionSchema,
      }),
    )
    .max(MAX_RULES_PER_SCOPE),
});

const groupIdParamsSchema = z.object({ id: z.string().min(1).max(128) });

const errorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

const errorResponses = {
  400: toJsonSchema(errorResponseSchema),
  401: toJsonSchema(errorResponseSchema),
  403: toJsonSchema(errorResponseSchema),
  404: toJsonSchema(errorResponseSchema),
} as const;

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError(
      'INVALID_REQUEST',
      result.error.issues.map((issue) => issue.message).join('; ') || 'Request validation failed',
    );
  }
  return result.data;
}

function actorIp(request: FastifyRequest): string | null {
  return clientIp(request.headers as Record<string, unknown>, request.ip);
}

/**
 * Group rules are readable by any member and writable by OWNER/ADMIN (design
 * §9.2). A non-member gets GROUP_NOT_FOUND, exactly like `GET /v1/groups/:id`,
 * so the filter API is not an existence oracle either.
 */
async function requireGroupMembership(
  groups: GroupService,
  groupId: string,
  userUuid: string,
): Promise<GroupMembership> {
  const membership = await groups.membership(groupId, userUuid);
  if (!membership) throw new AppError('GROUP_NOT_FOUND', 'Group not found');
  return membership;
}

function requireGroupFilterEditor(membership: GroupMembership): void {
  if (membership.role !== 'OWNER' && membership.role !== 'ADMIN') {
    throw new AppError('GROUP_ACCESS_DENIED', 'Only group owners and admins may edit group filters');
  }
}

function requireAdmin(ctx: AppContext, request: FastifyRequest): void {
  const identity = currentAuth(request);
  if (!isAdminUuid(ctx.config.adminUuids, identity.minecraftUuid)) {
    throw new AppError('FORBIDDEN', 'This endpoint requires an administrator UUID');
  }
}

export interface FilterRouteDeps {
  filters: FilterService;
  /** Optional: the app already owns a GroupService; a private one is built otherwise. */
  groups?: GroupService;
  /** Optional: same, for audit records of rule changes. */
  audit?: AuditService;
}

/* ------------------------------------------------------------------ */
/* Routes                                                             */
/* ------------------------------------------------------------------ */

/**
 * REST surface for filter rules (design §13.2):
 *
 *   GET/PUT /v1/filters/me               – per-recipient rules ("what may be sent to me")
 *   GET/PUT /v1/groups/:id/filters       – rules for one group
 *   GET/PUT /v1/admin/filters/global     – rules for the whole server (config.adminUuids)
 *
 * There is deliberately no endpoint to read another user's rules: the per-user
 * scope is private to its owner and to administrators using the admin tooling.
 */
export async function registerFilterRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  deps: FilterRouteDeps,
): Promise<void> {
  const auth = requireAuth(ctx);
  const groups = deps.groups ?? createGroupService(ctx);
  const audit = deps.audit ?? createAuditService(ctx);

  app.get(
    '/v1/filters/me',
    {
      preHandler: auth,
      schema: {
        tags: ['filters'],
        summary: 'Filter rules applied to messages addressed to the caller',
        security: [{ bearerAuth: [] }],
        response: {
          200: toJsonSchema(rulesResponseSchema),
          401: errorResponses[401],
        },
      },
    },
    async (request) => {
      const identity = currentAuth(request);
      const rules = await deps.filters.listRules('USER', identity.minecraftUuid);
      return { rules };
    },
  );

  app.put(
    '/v1/filters/me',
    {
      preHandler: auth,
      schema: {
        tags: ['filters'],
        summary: 'Replace the filter rules applied to messages addressed to the caller',
        security: [{ bearerAuth: [] }],
        body: toJsonSchema(replaceRulesBodySchema),
        response: {
          200: toJsonSchema(rulesResponseSchema),
          400: errorResponses[400],
          401: errorResponses[401],
        },
      },
    },
    async (request) => {
      const identity = currentAuth(request);
      const body = parse(replaceRulesBodySchema, request.body);

      const rules = await deps.filters.replaceRules(
        'USER',
        identity.minecraftUuid,
        body.rules,
        identity.minecraftUuid,
      );

      await audit.record({
        event: 'filter.rules.updated',
        actorUuid: identity.minecraftUuid,
        targetType: 'user',
        targetId: identity.minecraftUuid,
        ip: actorIp(request),
        metadata: { scope: 'USER', ruleCount: rules.length },
      });

      return { rules };
    },
  );

  app.get(
    '/v1/groups/:id/filters',
    {
      preHandler: auth,
      schema: {
        tags: ['filters'],
        summary: 'Filter rules of a group the caller belongs to',
        security: [{ bearerAuth: [] }],
        params: toJsonSchema(groupIdParamsSchema),
        response: {
          200: toJsonSchema(rulesResponseSchema),
          401: errorResponses[401],
          404: errorResponses[404],
        },
      },
    },
    async (request) => {
      const identity = currentAuth(request);
      const params = parse(groupIdParamsSchema, request.params);
      await requireGroupMembership(groups, params.id, identity.minecraftUuid);
      const rules = await deps.filters.listRules('GROUP', params.id);
      return { rules };
    },
  );

  app.put(
    '/v1/groups/:id/filters',
    {
      preHandler: auth,
      schema: {
        tags: ['filters'],
        summary: 'Replace the filter rules of a group (OWNER/ADMIN)',
        security: [{ bearerAuth: [] }],
        params: toJsonSchema(groupIdParamsSchema),
        body: toJsonSchema(replaceRulesBodySchema),
        response: {
          200: toJsonSchema(rulesResponseSchema),
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          404: errorResponses[404],
        },
      },
    },
    async (request) => {
      const identity = currentAuth(request);
      const params = parse(groupIdParamsSchema, request.params);
      const body = parse(replaceRulesBodySchema, request.body);

      const membership = await requireGroupMembership(groups, params.id, identity.minecraftUuid);
      requireGroupFilterEditor(membership);

      const rules = await deps.filters.replaceRules(
        'GROUP',
        params.id,
        body.rules,
        identity.minecraftUuid,
      );

      await audit.record({
        event: 'filter.rules.updated',
        actorUuid: identity.minecraftUuid,
        targetType: 'group',
        targetId: params.id,
        ip: actorIp(request),
        metadata: { scope: 'GROUP', ruleCount: rules.length },
      });

      return { rules };
    },
  );

  app.get(
    '/v1/admin/filters/global',
    {
      preHandler: auth,
      schema: {
        tags: ['filters'],
        summary: 'Global filter rules (administrator UUIDs only)',
        security: [{ bearerAuth: [] }],
        response: {
          200: toJsonSchema(rulesResponseSchema),
          401: errorResponses[401],
          403: errorResponses[403],
        },
      },
    },
    async (request) => {
      requireAdmin(ctx, request);
      const rules = await deps.filters.listRules('GLOBAL', null);
      return { rules };
    },
  );

  app.put(
    '/v1/admin/filters/global',
    {
      preHandler: auth,
      schema: {
        tags: ['filters'],
        summary: 'Replace the global filter rules (administrator UUIDs only)',
        security: [{ bearerAuth: [] }],
        body: toJsonSchema(replaceRulesBodySchema),
        response: {
          200: toJsonSchema(rulesResponseSchema),
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
        },
      },
    },
    async (request) => {
      requireAdmin(ctx, request);
      const identity = currentAuth(request);
      const body = parse(replaceRulesBodySchema, request.body);

      const rules = await deps.filters.replaceRules('GLOBAL', null, body.rules, identity.minecraftUuid);

      await audit.record({
        event: 'filter.rules.updated',
        actorUuid: identity.minecraftUuid,
        targetType: 'global',
        targetId: null,
        ip: actorIp(request),
        metadata: { scope: 'GLOBAL', ruleCount: rules.length },
      });

      return { rules };
    },
  );
}
