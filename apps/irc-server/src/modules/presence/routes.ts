import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { Errors } from '../../http/app-error.js';
import { currentAuth, requireAuth } from '../../http/require-auth.js';
import { toJsonSchema } from '../../http/zod-schema.js';
import type { ConnectionRegistry } from '../../runtime/contracts.js';
import type { GroupService } from '../../runtime/contracts.js';
import type { PresenceStore } from '../../runtime/presence.js';

const meSchema = z.object({
  online: z.boolean(),
  connections: z.number().int().nonnegative(),
  instanceId: z.string(),
});

const userPresenceSchema = z.object({
  minecraftUuid: z.string(),
  online: z.boolean(),
  connections: z.number().int().nonnegative(),
});

export interface PresenceDeps {
  presence: PresenceStore;
  registry: ConnectionRegistry;
  groups: GroupService;
}

/**
 * Presence is privacy-sensitive: a player may see their own status, and another
 * player's status only when they share a group (design §10.3). There is
 * deliberately no "list everyone online" endpoint.
 */
export async function registerPresenceRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  deps: PresenceDeps,
): Promise<void> {
  const auth = requireAuth(ctx);

  app.get(
    '/v1/presence/me',
    {
      preHandler: auth,
      schema: {
        tags: ['presence'],
        summary: 'My own presence',
        security: [{ bearerAuth: [] }],
        response: { 200: toJsonSchema(meSchema) },
      },
    },
    async (request) => {
      const identity = currentAuth(request);
      const records = await deps.presence.listRecords(identity.minecraftUuid);
      return {
        online: records.length > 0,
        connections: records.length,
        instanceId: ctx.instanceId,
      };
    },
  );

  app.get(
    '/v1/presence/:uuid',
    {
      preHandler: auth,
      schema: {
        tags: ['presence'],
        summary: 'Presence of a player you share a group with',
        security: [{ bearerAuth: [] }],
        response: {
          200: toJsonSchema(userPresenceSchema),
          403: toJsonSchema(z.object({ error: z.object({ code: z.string(), message: z.string() }) })),
        },
      },
    },
    async (request) => {
      const identity = currentAuth(request);
      const raw = String((request.params as { uuid?: string }).uuid ?? '');
      const target = raw.toLowerCase();
      if (!/^[0-9a-f-]{32,36}$/.test(target)) throw Errors.invalid('uuid is malformed');

      if (target !== identity.minecraftUuid) {
        const isAdmin = ctx.config.adminUuids.includes(identity.minecraftUuid);
        let sharesGroup = isAdmin;
        if (!sharesGroup) {
          const mine = await deps.groups.listGroupsForUser(identity.minecraftUuid);
          for (const group of mine) {
            const membership = await deps.groups.membership(group.id, target);
            if (membership) {
              sharesGroup = true;
              break;
            }
          }
        }
        if (!sharesGroup) throw Errors.forbidden('You can only see presence of players you share a group with');
      }

      const records = await deps.presence.listRecords(target);
      return {
        minecraftUuid: target,
        online: records.length > 0,
        connections: records.length,
      };
    },
  );
}
