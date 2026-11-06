import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { healthLiveResponseSchema, healthReadyResponseSchema } from '@skymatrix/api-contract';
import { toJsonSchema } from '../../http/zod-schema.js';

export interface HealthProbes {
  pingMongo: () => Promise<void>;
  pingRedis: () => Promise<void>;
}

/**
 * Liveness never touches dependencies (a dead dependency must not restart a
 * healthy process). Readiness is dependency-aware: it is what a load balancer
 * should use to decide whether to send traffic.
 */
export async function registerHealthRoutes(
  app: FastifyInstance,
  _ctx: AppContext,
  probes: HealthProbes,
): Promise<void> {
  const startedAt = Date.now();

  app.get(
    '/api/v1/health/live',
    {
      schema: {
        tags: ['health'],
        summary: 'Liveness probe',
        response: { 200: toJsonSchema(healthLiveResponseSchema) },
      },
    },
    async () => ({ status: 'ok' as const, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) }),
  );

  app.get(
    '/api/v1/health/ready',
    {
      schema: {
        tags: ['health'],
        summary: 'Readiness probe (MongoDB + Redis)',
        response: { 200: toJsonSchema(healthReadyResponseSchema), 503: toJsonSchema(healthReadyResponseSchema) },
      },
    },
    async (_request, reply) => {
      const checks: Record<'mongo' | 'redis', 'ok' | 'fail'> = { mongo: 'ok', redis: 'ok' };

      try {
        await probes.pingMongo();
      } catch {
        checks.mongo = 'fail';
      }
      try {
        await probes.pingRedis();
      } catch {
        checks.redis = 'fail';
      }

      const healthy = checks.mongo === 'ok' && checks.redis === 'ok';
      reply.status(healthy ? 200 : 503);
      return { status: healthy ? ('ok' as const) : ('degraded' as const), checks };
    },
  );
}
