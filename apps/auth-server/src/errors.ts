import type { ErrorCode } from '@hotaru/shared-types';

/**
 * Every failure the API reports deliberately is an AppError: it carries the
 * machine-readable code clients branch on, the HTTP status, and whether the
 * caller may safely retry.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode: number,
    options: { retryable?: boolean; details?: unknown; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = options.retryable ?? false;
    if (options.details !== undefined) this.details = options.details;
  }
}

export const Errors = {
  invalidRequest: (message: string, details?: unknown) =>
    new AppError('INVALID_REQUEST', message, 400, details === undefined ? {} : { details }),

  challengeNotFound: () =>
    new AppError('CHALLENGE_NOT_FOUND', 'No pending challenge for this id', 404),

  challengeExpired: () =>
    new AppError('CHALLENGE_EXPIRED', 'Challenge expired before verification', 410),

  challengeConsumed: () =>
    new AppError('CHALLENGE_CONSUMED', 'Challenge was already consumed', 409),

  notPremiumSession: () =>
    new AppError(
      'NOT_A_PREMIUM_SESSION',
      'Mojang did not confirm an active premium session for this player',
      401,
    ),

  mojangUnavailable: (cause?: unknown) =>
    new AppError(
      'MOJANG_UNAVAILABLE',
      'Mojang session server is temporarily unavailable; obtain a new challenge and retry',
      503,
      { retryable: true, ...(cause === undefined ? {} : { cause }) },
    ),

  rateLimited: (retryAfterSeconds: number) =>
    new AppError('RATE_LIMITED', 'Too many authentication attempts', 429, {
      retryable: true,
      details: { retryAfterSeconds },
    }),

  unauthorized: (message = 'Missing or invalid credentials') =>
    new AppError('UNAUTHORIZED', message, 401),

  tokenExpired: () => new AppError('TOKEN_EXPIRED', 'Access token has expired', 401, { retryable: true }),

  sessionRevoked: () => new AppError('SESSION_REVOKED', 'Session has been revoked', 401),

  refreshReused: () =>
    new AppError('REFRESH_REUSED', 'Refresh token reuse detected; session revoked', 401),

  userBanned: () => new AppError('USER_BANNED', 'Account is banned', 403),

  forbidden: (message = 'Insufficient scope') => new AppError('FORBIDDEN', message, 403),

  notFound: (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found`, 404),

  internal: (cause?: unknown) =>
    new AppError('INTERNAL', 'Internal server error', 500, cause === undefined ? {} : { cause }),
};
