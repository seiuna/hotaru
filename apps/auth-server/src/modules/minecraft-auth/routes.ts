import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  challengeRequestSchema,
  challengeResponseSchema,
  tokenResponseSchema,
  verifyRequestSchema,
} from '@hotaru/api-contract';
import type { AppContext } from '../../context.js';
import { clientIp, toJsonSchema, userAgentOf } from '../../http/zod-schema.js';
import { createChallenge, verifyChallenge, type AuthRequestMeta } from './service.js';

function requestMeta(request: FastifyRequest): AuthRequestMeta {
  return {
    ip: clientIp(request.headers, request.ip),
    userAgent: userAgentOf(request.headers),
  };
}

/**
 * Public Minecraft handshake endpoints.
 *
 * Both routes parse the body with the shared Zod schema (a ZodError becomes a
 * 400 INVALID_REQUEST in the global handler) *and* expose the same schema as
 * JSON Schema for OpenAPI/request-shape validation.
 */
export async function registerMinecraftAuthRoutes(
  app: FastifyInstance,
  _ctx: AppContext,
): Promise<void> {
  app.post<{ Body: unknown }>(
    '/api/v1/auth/minecraft/challenge',
    {
      schema: {
        tags: ['auth'],
        summary: 'Start the Minecraft premium handshake',
        body: toJsonSchema(challengeRequestSchema),
        response: { 200: toJsonSchema(challengeResponseSchema) },
      },
    },
    async (request) => {
      const ctx = request.server.ctx;
      const body = challengeRequestSchema.parse(request.body);
      const meta = requestMeta(request);
      return createChallenge(ctx, { username: body.username, client: body.client, ip: meta.ip });
    },
  );

  app.post<{ Body: unknown }>(
    '/api/v1/auth/minecraft/verify',
    {
      schema: {
        tags: ['auth'],
        summary: 'Verify the encrypted handshake and issue tokens',
        body: toJsonSchema(verifyRequestSchema),
        response: { 200: toJsonSchema(tokenResponseSchema) },
      },
    },
    async (request) => {
      const ctx = request.server.ctx;
      const body = verifyRequestSchema.parse(request.body);
      return verifyChallenge(ctx, body, requestMeta(request));
    },
  );
}
