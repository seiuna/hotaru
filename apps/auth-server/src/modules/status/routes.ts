import type { FastifyInstance } from 'fastify';
import { statusResponseSchema, type ServiceStatus } from '@hotaru/api-contract';
import type { AppContext } from '../../context.js';
import { pingMongo } from '../../infrastructure/mongo/connection.js';
import { pingRedis } from '../../infrastructure/redis/client.js';
import { toJsonSchema } from '../../http/zod-schema.js';

async function timedProbe(
  id: string,
  name: string,
  probe: () => Promise<void>,
): Promise<ServiceStatus> {
  const started = performance.now();
  try {
    await probe();
    return {
      id,
      name,
      status: 'up',
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      detail: null,
    };
  } catch (error) {
    return {
      id,
      name,
      status: 'down',
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function probeIrc(url: string): Promise<ServiceStatus> {
  const started = performance.now();
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(2500),
    });
    const latency = Math.max(0, Math.round(performance.now() - started));
    if (response.ok) {
      return { id: 'irc', name: 'IRC Server', status: 'up', latencyMs: latency, detail: null };
    }
    return {
      id: 'irc',
      name: 'IRC Server',
      status: 'degraded',
      latencyMs: latency,
      detail: `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      id: 'irc',
      name: 'IRC Server',
      status: 'down',
      latencyMs: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Public status feed for the login-free status page. It exposes only
 * availability and latency, not user data or configuration.
 */
export async function registerStatusRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get(
    '/api/v1/status',
    {
      schema: {
        tags: ['health'],
        summary: 'Public service availability and latency snapshot',
        response: { 200: toJsonSchema(statusResponseSchema) },
      },
    },
    async () => {
      const [mongo, redis, irc] = await Promise.all([
        timedProbe('mongodb', 'MongoDB', pingMongo),
        timedProbe('redis', 'Redis', pingRedis),
        probeIrc(ctx.config.ircHealthUrl),
      ]);

      const services: ServiceStatus[] = [
        { id: 'auth', name: 'Auth API', status: 'up', latencyMs: null, detail: null },
        mongo,
        redis,
        irc,
      ];
      return { generatedAt: new Date().toISOString(), services };
    },
  );
}
