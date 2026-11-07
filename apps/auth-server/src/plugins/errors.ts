import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import type { FastifyError, FastifyInstance } from 'fastify';
import { AppError } from '../errors.js';
import type { ApiErrorBody } from '@hotaru/shared-types';

function body(code: string, message: string, retryable: boolean, details?: unknown): ApiErrorBody {
  const error: ApiErrorBody['error'] = {
    code: code as ApiErrorBody['error']['code'],
    message,
    retryable,
  };
  if (details !== undefined) error.details = details;
  return { error };
}

/**
 * Single place that turns any thrown value into the documented error envelope.
 * Nothing leaks a stack trace or a Mongo/internal message to a caller.
 */
export const errorHandlerPlugin = fp(async (app: FastifyInstance) => {
  app.setErrorHandler((error: FastifyError | AppError | ZodError, request, reply) => {
    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      request.log.info({ details }, 'request validation failed');
      return reply.status(400).send(body('INVALID_REQUEST', 'Request validation failed', false, details));
    }

    if (error instanceof AppError) {
      const level = error.statusCode >= 500 ? 'error' : 'info';
      request.log[level]({ code: error.code, err: error }, 'request failed');
      const payload = body(error.code, error.message, error.retryable, error.details);
      if (error.statusCode === 429 && error.details && typeof error.details === 'object') {
        const retryAfter = (error.details as { retryAfterSeconds?: number }).retryAfterSeconds;
        if (typeof retryAfter === 'number') reply.header('retry-after', String(retryAfter));
      }
      return reply.status(error.statusCode).send(payload);
    }

    const status = error.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      request.log.info({ err: error }, 'client error');
      return reply.status(status).send(body('INVALID_REQUEST', error.message, false));
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send(body('INTERNAL', 'Internal server error', false));
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send(body('NOT_FOUND', `Route ${request.method} ${request.url} not found`, false)),
  );
});
