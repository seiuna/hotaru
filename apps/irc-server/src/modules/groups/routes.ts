import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { AppError } from '../../http/app-error.js';
import { currentAuth, requireAuth } from '../../http/require-auth.js';
import { clientIp, toJsonSchema } from '../../http/zod-schema.js';
import type { AuditService, GroupService } from '../../runtime/contracts.js';
import { toCanonicalUuid } from './ids.js';
import { createGroupCreationQuota } from './quota.js';

/* ------------------------------------------------------------------ */
/* Wire schemas (also exported to the OpenAPI document)                */
/* ------------------------------------------------------------------ */

const visibilitySchema = z.enum(['PRIVATE', 'PUBLIC']);
const groupRoleSchema = z.enum(['OWNER', 'ADMIN', 'MEMBER']);
/** A role a member can *hold* after an invite/update; ownership is not assignable. */
const assignableRoleSchema = z.enum(['ADMIN', 'MEMBER']);

export const groupSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  ownerUuid: z.string(),
  visibility: visibilitySchema,
  maxMembers: z.number().int(),
  status: z.enum(['ACTIVE']),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const groupResponseSchema = z.object({ group: groupSummarySchema });
export const groupListResponseSchema = z.object({ groups: z.array(groupSummarySchema) });

export const groupMembershipSchema = z.object({
  groupId: z.string(),
  userUuid: z.string(),
  role: groupRoleSchema,
  joinedAt: z.string(),
});
export const memberResponseSchema = z.object({ member: groupMembershipSchema });

const errorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

/** 204 responses carry no body; declaring it keeps Fastify's reply typing honest. */
const emptyResponseSchema = z.null();

export const groupIdParamsSchema = z.object({ id: z.string().min(1).max(128) });
export const memberParamsSchema = z.object({
  id: z.string().min(1).max(128),
  uuid: z.string().min(1).max(64),
});

export const createGroupBodySchema = z.object({
  /** Display name; duplicate names are allowed (the id is the identity). */
  name: z.string().min(1).max(64),
  visibility: visibilitySchema.optional(),
  maxMembers: z.number().int().min(2).optional(),
});

const updateGroupBodySchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    visibility: visibilitySchema.optional(),
    maxMembers: z.number().int().min(2).optional(),
  })
  .refine(
    (body) => body.name !== undefined || body.visibility !== undefined || body.maxMembers !== undefined,
    { message: 'At least one of name, visibility or maxMembers is required' },
  );

const addMemberBodySchema = z.object({
  userUuid: z.string().min(1).max(64),
  role: assignableRoleSchema.optional(),
});

const setMemberRoleBodySchema = z.object({ role: assignableRoleSchema });

const errorResponses = {
  400: toJsonSchema(errorResponseSchema),
  401: toJsonSchema(errorResponseSchema),
  403: toJsonSchema(errorResponseSchema),
  404: toJsonSchema(errorResponseSchema),
  409: toJsonSchema(errorResponseSchema),
  429: toJsonSchema(errorResponseSchema),
} as const;

/* ------------------------------------------------------------------ */
/* Routes                                                             */
/* ------------------------------------------------------------------ */

export interface GroupRouteDeps {
  groups: GroupService;
  audit: AuditService;
}

interface GroupPatch {
  name?: string;
  visibility?: 'PRIVATE' | 'PUBLIC';
  maxMembers?: number;
}

function actorIp(request: FastifyRequest): string | null {
  return clientIp(request.headers as Record<string, unknown>, request.ip);
}

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

/**
 * REST surface for groups (design §13.1).
 *
 * Every route requires a valid access token (`requireAuth`), and every decision
 * about roles is delegated to `GroupService` — the HTTP layer only parses input,
 * passes the *authenticated* UUID (never a body/param identity) and records the
 * audit event. Responses never contain a group the caller cannot see.
 */
export async function registerGroupRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  deps: GroupRouteDeps,
): Promise<void> {
  const auth = requireAuth(ctx);
  const creationQuota = createGroupCreationQuota(ctx);

  app.post(
    '/v1/groups',
    {
      preHandler: auth,
      schema: {
        tags: ['groups'],
        summary: 'Create a group; the caller becomes its OWNER',
        security: [{ bearerAuth: [] }],
        body: toJsonSchema(createGroupBodySchema),
        response: {
          201: toJsonSchema(groupResponseSchema),
          400: errorResponses[400],
          401: errorResponses[401],
          429: errorResponses[429],
        },
      },
    },
    async (request, reply) => {
      const identity = currentAuth(request);
      const body = parse(createGroupBodySchema, request.body);

      // Anti-abuse quota (`config.createGroupPerHour`), checked before any write.
      const admission = await creationQuota.consume(identity.minecraftUuid);
      if (!admission.allowed) {
        reply.header('retry-after', String(admission.retryAfterSeconds));
        throw new AppError(
          'RATE_LIMITED',
          `Group creation limit reached (${admission.limit} per hour); try again in ${admission.retryAfterSeconds} seconds`,
        );
      }

      const created = await deps.groups.createGroup({
        ownerUuid: identity.minecraftUuid,
        name: body.name,
        ...(body.maxMembers === undefined ? {} : { maxMembers: body.maxMembers }),
      });

      // `createGroup` always starts PRIVATE; PUBLIC is a second, owner-authorised
      // step so a failed creation cannot leave a public group behind.
      const group =
        body.visibility !== undefined && body.visibility !== created.visibility
          ? await deps.groups.updateGroup(created.id, identity.minecraftUuid, {
              visibility: body.visibility,
            })
          : created;

      await deps.audit.record({
        event: 'group.created',
        actorUuid: identity.minecraftUuid,
        targetType: 'group',
        targetId: group.id,
        ip: actorIp(request),
        metadata: { visibility: group.visibility, maxMembers: group.maxMembers },
      });

      return reply.status(201).send({ group });
    },
  );

  app.get(
    '/v1/groups',
    {
      preHandler: auth,
      schema: {
        tags: ['groups'],
        summary: 'Groups the caller belongs to',
        security: [{ bearerAuth: [] }],
        response: {
          200: toJsonSchema(groupListResponseSchema),
          401: errorResponses[401],
        },
      },
    },
    async (request) => {
      const identity = currentAuth(request);
      const groups = await deps.groups.listGroupsForUser(identity.minecraftUuid);
      return { groups };
    },
  );

  app.get(
    '/v1/groups/:id',
    {
      preHandler: auth,
      schema: {
        tags: ['groups'],
        summary: 'A group the caller is a member of',
        security: [{ bearerAuth: [] }],
        params: toJsonSchema(groupIdParamsSchema),
        response: {
          200: toJsonSchema(groupResponseSchema),
          401: errorResponses[401],
          404: errorResponses[404],
        },
      },
    },
    async (request) => {
      const identity = currentAuth(request);
      const params = parse(groupIdParamsSchema, request.params);
      const group = await deps.groups.getGroup(params.id, identity.minecraftUuid);
      return { group };
    },
  );

  app.patch(
    '/v1/groups/:id',
    {
      preHandler: auth,
      schema: {
        tags: ['groups'],
        summary: 'Rename a group, change visibility or the member cap (OWNER/ADMIN)',
        security: [{ bearerAuth: [] }],
        params: toJsonSchema(groupIdParamsSchema),
        body: toJsonSchema(updateGroupBodySchema),
        response: {
          200: toJsonSchema(groupResponseSchema),
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
      const body = parse(updateGroupBodySchema, request.body);

      const patch: GroupPatch = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.visibility !== undefined) patch.visibility = body.visibility;
      if (body.maxMembers !== undefined) patch.maxMembers = body.maxMembers;

      const group = await deps.groups.updateGroup(params.id, identity.minecraftUuid, patch);

      await deps.audit.record({
        event: 'group.updated',
        actorUuid: identity.minecraftUuid,
        targetType: 'group',
        targetId: group.id,
        ip: actorIp(request),
        metadata: { fields: Object.keys(patch) },
      });

      return { group };
    },
  );

  app.delete(
    '/v1/groups/:id',
    {
      preHandler: auth,
      schema: {
        tags: ['groups'],
        summary: 'Delete a group (OWNER only); its memberships are removed',
        security: [{ bearerAuth: [] }],
        params: toJsonSchema(groupIdParamsSchema),
        response: {
          204: toJsonSchema(emptyResponseSchema),
          401: errorResponses[401],
          403: errorResponses[403],
          404: errorResponses[404],
        },
      },
    },
    async (request, reply) => {
      const identity = currentAuth(request);
      const params = parse(groupIdParamsSchema, request.params);

      await deps.groups.deleteGroup(params.id, identity.minecraftUuid);

      await deps.audit.record({
        event: 'group.deleted',
        actorUuid: identity.minecraftUuid,
        targetType: 'group',
        targetId: params.id,
        ip: actorIp(request),
      });

      return reply.status(204).send();
    },
  );

  app.post(
    '/v1/groups/:id/members',
    {
      preHandler: auth,
      schema: {
        tags: ['groups'],
        summary: 'Invite a member (OWNER may invite ADMIN; ADMIN may invite MEMBER)',
        security: [{ bearerAuth: [] }],
        params: toJsonSchema(groupIdParamsSchema),
        body: toJsonSchema(addMemberBodySchema),
        response: {
          201: toJsonSchema(memberResponseSchema),
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          404: errorResponses[404],
          409: errorResponses[409],
        },
      },
    },
    async (request, reply) => {
      const identity = currentAuth(request);
      const params = parse(groupIdParamsSchema, request.params);
      const body = parse(addMemberBodySchema, request.body);

      const member =
        body.role === undefined
          ? await deps.groups.addMember(params.id, identity.minecraftUuid, body.userUuid)
          : await deps.groups.addMember(params.id, identity.minecraftUuid, body.userUuid, body.role);

      await deps.audit.record({
        event: 'group.member.joined',
        actorUuid: identity.minecraftUuid,
        targetType: 'group',
        targetId: params.id,
        ip: actorIp(request),
        metadata: { memberUuid: member.userUuid, role: member.role },
      });

      return reply.status(201).send({ member });
    },
  );

  app.patch(
    '/v1/groups/:id/members/:uuid',
    {
      preHandler: auth,
      schema: {
        tags: ['groups'],
        summary: 'Change a member role (OWNER only; ADMIN or MEMBER)',
        security: [{ bearerAuth: [] }],
        params: toJsonSchema(memberParamsSchema),
        body: toJsonSchema(setMemberRoleBodySchema),
        response: {
          200: toJsonSchema(memberResponseSchema),
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          404: errorResponses[404],
        },
      },
    },
    async (request) => {
      const identity = currentAuth(request);
      const params = parse(memberParamsSchema, request.params);
      const body = parse(setMemberRoleBodySchema, request.body);

      const member = await deps.groups.setMemberRole(
        params.id,
        identity.minecraftUuid,
        params.uuid,
        body.role,
      );

      await deps.audit.record({
        event: 'group.member.role_changed',
        actorUuid: identity.minecraftUuid,
        targetType: 'group',
        targetId: params.id,
        ip: actorIp(request),
        metadata: { memberUuid: member.userUuid, role: member.role },
      });

      return { member };
    },
  );

  app.delete(
    '/v1/groups/:id/members/:uuid',
    {
      preHandler: auth,
      schema: {
        tags: ['groups'],
        summary: 'Remove a member, or leave the group when :uuid is the caller',
        security: [{ bearerAuth: [] }],
        params: toJsonSchema(memberParamsSchema),
        response: {
          204: toJsonSchema(emptyResponseSchema),
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          404: errorResponses[404],
        },
      },
    },
    async (request, reply) => {
      const identity = currentAuth(request);
      const params = parse(memberParamsSchema, request.params);
      const selfUuid = toCanonicalUuid(identity.minecraftUuid);
      const isSelf = toCanonicalUuid(params.uuid) === selfUuid;

      await deps.groups.removeMember(params.id, identity.minecraftUuid, params.uuid);

      await deps.audit.record({
        event: isSelf ? 'group.member.left' : 'group.member.removed',
        actorUuid: identity.minecraftUuid,
        targetType: 'group',
        targetId: params.id,
        ip: actorIp(request),
        metadata: { memberUuid: toCanonicalUuid(params.uuid) },
      });

      return reply.status(204).send();
    },
  );
}
