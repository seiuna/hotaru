import Fastify, { type FastifyInstance } from 'fastify';
import type { AppContext } from './context.js';
import { AppError } from './http/app-error.js';
import { registerFilterRoutes } from './modules/filters/routes.js';
import { registerGroupRoutes } from './modules/groups/routes.js';
import { registerHealthRoutes } from './modules/health/routes.js';
import { registerPresenceRoutes } from './modules/presence/routes.js';
import type { Runtime } from './runtime/index.js';
import { attachWebSocket, type WebSocketHandle } from './ws/attach.js';

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
    runtime: Runtime;
  }
}

export interface BuiltApp {
  app: FastifyInstance;
  ws: WebSocketHandle;
}

/**
 * Builds the HTTP + WebSocket app without listening, so tests can inject
 * requests and open sockets against a bound server they control.
 */
export async function buildApp(ctx: AppContext, runtime: Runtime): Promise<BuiltApp> {
  const app = Fastify({
    logger: {
      level: ctx.config.logLevel,
      // Tokens and payloads must never reach the logs.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    trustProxy: true,
    bodyLimit: 128 * 1024,
  });

  app.decorate('ctx', ctx);
  app.decorate('runtime', runtime);

  app.setErrorHandler((rawError, request, reply) => {
    if (rawError instanceof AppError) {
      request.log.info({ code: rawError.code }, 'request failed');
      return reply
        .status(rawError.statusCode)
        .send({ error: { code: rawError.code, message: rawError.message } });
    }
    const error = rawError as Error & { statusCode?: number };
    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      return reply
        .status(error.statusCode)
        .send({ error: { code: 'INVALID_REQUEST', message: error.message } });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Internal error' } });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found` },
    }),
  );

  const ws = attachWebSocket(app, {
    ctx,
    registry: runtime.registry,
    presence: runtime.presence,
    dispatcher: runtime.dispatcher,
    dedupe: runtime.dedupe,
    groups: runtime.groups,
    filters: runtime.filters,
    audit: runtime.audit,
  });

  await registerHealthRoutes(app, ctx, {
    audit: runtime.audit,
    connectionCount: () => ws.connectionCount(),
  });
  await registerGroupRoutes(app, ctx, { groups: runtime.groups, audit: runtime.audit });
  await registerFilterRoutes(app, ctx, { filters: runtime.filters });
  await registerPresenceRoutes(app, ctx, {
    presence: runtime.presence,
    registry: runtime.registry,
    groups: runtime.groups,
  });

  return { app, ws };
}
