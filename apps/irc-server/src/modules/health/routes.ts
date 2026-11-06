import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import type { AuditService } from '../../runtime/contracts.js';
import { pingMongo } from '../../infrastructure/mongo/connection.js';
import { pingRedis } from '../../infrastructure/redis/client.js';
import { Errors } from '../../http/app-error.js';
import { currentAuth, requireAuth } from '../../http/require-auth.js';
import { toJsonSchema } from '../../http/zod-schema.js';
import { z } from 'zod';

const liveSchema = z.object({
  status: z.literal('ok'),
  uptimeSeconds: z.number().int().nonnegative(),
});

const readySchema = z.object({
  status: z.enum(['ok', 'degraded']),
  checks: z.record(z.enum(['ok', 'fail'])),
  connections: z.number().int().nonnegative(),
});

export interface HealthDeps {
  audit: AuditService;
  connectionCount: () => number;
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  deps: HealthDeps,
): Promise<void> {
  const startedAt = Date.now();

  app.get(
    '/health/live',
    {
      schema: {
        response: { 200: toJsonSchema(liveSchema) },
      },
    },
    async () => ({
      status: 'ok' as const,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    }),
  );

  app.get(
    '/health/ready',
    {
      schema: {
        response: {
          200: toJsonSchema(readySchema),
          503: toJsonSchema(readySchema),
        },
      },
    },
    async (_request, reply) => {
      const checks: Record<'mongo' | 'redis', 'ok' | 'fail'> = { mongo: 'ok', redis: 'ok' };
      try {
        await pingMongo();
      } catch {
        checks.mongo = 'fail';
      }
      try {
        await pingRedis();
      } catch {
        checks.redis = 'fail';
      }
      const healthy = checks.mongo === 'ok' && checks.redis === 'ok';
      reply.status(healthy ? 200 : 503);
      return {
        status: healthy ? ('ok' as const) : ('degraded' as const),
        checks,
        connections: deps.connectionCount(),
      };
    },
  );

  /**
   * Operational counters. Admin-only on purpose (design §13.4): the numbers say
   * how busy the node is and are not useful to players. Not proxied by Caddy, so
   * in production it is reachable only from inside the Docker network.
   */
  app.get(
    '/metrics',
    {
      preHandler: requireAuth(ctx),
      schema: {
      },
    },
    async (request) => {
      const identity = currentAuth(request);
      if (!ctx.config.adminUuids.includes(identity.minecraftUuid)) {
        throw Errors.forbidden('Admin access required');
      }
      return {
        connections: deps.connectionCount(),
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      };
    },
  );
}
