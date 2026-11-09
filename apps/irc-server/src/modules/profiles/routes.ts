import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { profileUpdatedFrame, profileTags, type PlayerProfile } from '@hotaru/srp-protocol';
import type { AppContext } from '../../context.js';
import { Errors } from '../../http/app-error.js';
import { currentAuth, requireAuth } from '../../http/require-auth.js';
import { toJsonSchema } from '../../http/zod-schema.js';
import type { ConnectionRegistry } from '../../runtime/contracts.js';
import { getPlayerProfile, getStoredProfile, setAdminProfile, setOwnNickname } from './service.js';

const selfProfileSchema = z.object({ nickname: z.string().min(3).max(24) });
const adminProfileSchema = z.object({
  nickname: z.string().min(3).max(24).optional(),
  tags: z.array(z.string()).max(3).optional(),
});

const profileSchema = z.object({
  nickname: z.string(),
  tags: z.array(z.string()),
});

const adminProfileResponseSchema = z.object({
  minecraftUuid: z.string(),
  nickname: z.string().nullable(),
  manualTags: z.array(z.string()),
});

export interface ProfileDeps {
  registry: ConnectionRegistry;
}

function isAdmin(ctx: AppContext, minecraftUuid: string, scopes: readonly string[]): boolean {
  return scopes.includes('admin:users') || ctx.config.adminUuids.includes(minecraftUuid);
}

/**
 * Push the profile to every connected client. Connections of the target also
 * get their cached fields updated, so the next message uses the new nickname.
 */
export function pushProfileUpdate(
  registry: ConnectionRegistry,
  minecraftUuid: string,
  nickname: string,
  manualTags: readonly string[],
): void {
  const own = registry.listByUser(minecraftUuid);
  const tags = profileTags(own[0]?.scopes ?? [], manualTags);
  for (const connection of own) {
    connection.nickname = nickname;
    connection.tags = tags;
  }
  const frame = profileUpdatedFrame({ minecraftUuid, nickname, tags });
  for (const connection of registry.listAll()) connection.send(frame);
}

export async function registerProfileRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  deps: ProfileDeps,
): Promise<void> {
  const auth = requireAuth(ctx);

  app.get(
    '/v1/me/profile',
    {
      preHandler: auth,
      schema: {
        security: [{ bearerAuth: [] }],
        response: { 200: toJsonSchema(profileSchema) },
      },
    },
    async (request): Promise<PlayerProfile> => {
      const identity = currentAuth(request);
      return getPlayerProfile(identity.minecraftUuid, identity.username, identity.scopes);
    },
  );

  app.put(
    '/v1/me/profile',
    {
      preHandler: auth,
      schema: {
        security: [{ bearerAuth: [] }],
        body: toJsonSchema(selfProfileSchema),
        response: { 200: toJsonSchema(profileSchema) },
      },
    },
    async (request): Promise<PlayerProfile> => {
      const identity = currentAuth(request);
      const body = selfProfileSchema.parse(request.body);
      const profile = await setOwnNickname(
        identity.minecraftUuid,
        identity.username,
        body.nickname,
        identity.scopes,
      );
      const stored = await getStoredProfile(identity.minecraftUuid);
      pushProfileUpdate(deps.registry, identity.minecraftUuid, profile.nickname, stored.manualTags);
      return profile;
    },
  );

  app.put(
    '/v1/admin/users/:uuid/profile',
    {
      preHandler: auth,
      schema: {
        security: [{ bearerAuth: [] }],
        body: toJsonSchema(adminProfileSchema),
        response: { 200: toJsonSchema(adminProfileResponseSchema) },
      },
    },
    async (request) => {
      const identity = currentAuth(request);
      if (!isAdmin(ctx, identity.minecraftUuid, identity.scopes)) {
        throw Errors.forbidden('admin:users is required');
      }
      const raw = String((request.params as { uuid?: string }).uuid ?? '').toLowerCase();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(raw)) {
        throw Errors.invalid('uuid is malformed');
      }
      const body = adminProfileSchema.parse(request.body);
      const input: { nickname?: string; tags?: string[] } = {};
      if (body.nickname !== undefined) input.nickname = body.nickname;
      if (body.tags !== undefined) input.tags = body.tags;
      await setAdminProfile(raw, raw, input, identity.scopes);
      const stored = await getStoredProfile(raw);
      const nickname = stored.nickname ?? deps.registry.listByUser(raw)[0]?.nickname ?? raw;
      pushProfileUpdate(deps.registry, raw, nickname, stored.manualTags);
      return { minecraftUuid: raw, nickname: stored.nickname, manualTags: stored.manualTags };
    },
  );
}
