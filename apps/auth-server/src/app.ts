import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { errorHandlerPlugin } from './plugins/errors.js';
import type { AppContext } from './context.js';
import { pingMongo } from './infrastructure/mongo/connection.js';
import { pingRedis } from './infrastructure/redis/client.js';
import { registerHealthRoutes } from './modules/health/routes.js';
import { registerMinecraftAuthRoutes } from './modules/minecraft-auth/routes.js';
import { registerPortalRoutes } from './modules/portal/routes.js';
import { registerTokenRoutes } from './modules/tokens/routes.js';
import { registerUserRoutes } from './modules/users/routes.js';
import { registerAdminRoutes } from './modules/admin/routes.js';

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}

/**
 * Builds the HTTP app without binding a port, so tests can use `app.inject()`.
 * Route modules receive the same AppContext and never reach for globals.
 */
export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: ctx.config.logLevel,
      // Do not log authorization headers; tokens must never reach the log files.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    trustProxy: true,
    bodyLimit: 64 * 1024,
    // Request logging is controlled by LOG_LEVEL rather than the deprecated
    // `disableRequestLogging` option (fastify 6 removes it, and its replacement
    // `logController` requires a LogController instance). Tests set LOG_LEVEL=warn
    // or silent, which is enough to keep their output clean.
  });

  app.decorate('ctx', ctx);

  await app.register(cors, {
    origin: ctx.config.corsOrigins.length > 0 ? ctx.config.corsOrigins : false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization'],
    maxAge: 600,
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Hotaru MC Auth Platform',
        description:
          'Independent Minecraft premium authentication and authorization service. ' +
          'Verifies Mojang sessions via the join/hasJoined handshake and issues its own Ed25519 JWTs.',
        version: '0.1.0',
      },
      servers: [{ url: ctx.config.publicBaseUrl }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
      tags: [
        { name: 'auth', description: 'Challenge/verify, refresh, logout, JWKS' },
        { name: 'users', description: 'Self-service account data' },
        { name: 'portal', description: 'User portal account activation, login and Minecraft binding' },
        { name: 'admin', description: 'Administration (requires admin:users scope)' },
        { name: 'health', description: 'Liveness and readiness' },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

  await app.register(errorHandlerPlugin);

  app.get('/api/v1/auth/jwks', {
    schema: {
      tags: ['auth'],
      summary: 'JSON Web Key Set for access-token verification',
      response: {
        200: {
          type: 'object',
          properties: {
            keys: {
              type: 'array',
              items: {
                type: 'object',
                // Enumerate the members we publish: fast-json-stringify drops any
                // property not declared here, and `{type:'object'}` alone would
                // serialize every key as `{}`.
                properties: {
                  kty: { type: 'string' },
                  crv: { type: 'string' },
                  x: { type: 'string' },
                  use: { type: 'string' },
                  alg: { type: 'string' },
                  kid: { type: 'string' },
                },
                additionalProperties: true,
              },
            },
          },
        },
      },
    },
    handler: async () => ({ keys: [ctx.keys.jwt.publicJwk] }),
  });

  await registerHealthRoutes(app, ctx, { pingMongo, pingRedis });
  await registerMinecraftAuthRoutes(app, ctx);
  await registerPortalRoutes(app, ctx);
  await registerTokenRoutes(app, ctx);
  await registerUserRoutes(app, ctx);
  await registerAdminRoutes(app, ctx);

  return app;
}
