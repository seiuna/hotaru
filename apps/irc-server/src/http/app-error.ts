/** Error codes the REST surface can emit. WebSocket errors use SRP codes instead. */
export type AppErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'RATE_LIMITED'
  | 'GROUP_NOT_FOUND'
  | 'GROUP_ACCESS_DENIED'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL';

const STATUS: Record<AppErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID_REQUEST: 400,
  RATE_LIMITED: 429,
  GROUP_NOT_FOUND: 404,
  GROUP_ACCESS_DENIED: 403,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL: 500,
};

/**
 * Every deliberate REST failure. The global error handler turns it into
 * `{ error: { code, message } }`; nothing internal leaks.
 */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: AppErrorCode, message: string, statusCode?: number, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode ?? STATUS[code];
    if (details !== undefined) this.details = details;
  }
}

export const Errors = {
  unauthorized: (message = 'Missing or invalid access token') =>
    new AppError('UNAUTHORIZED', message),
  forbidden: (message = 'Not allowed') => new AppError('FORBIDDEN', message),
  notFound: (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found`),
  invalid: (message: string, details?: unknown) => new AppError('INVALID_REQUEST', message, 400, details),
  rateLimited: (message = 'Too many requests') => new AppError('RATE_LIMITED', message),
  groupNotFound: () => new AppError('GROUP_NOT_FOUND', 'Group not found'),
  groupAccessDenied: () => new AppError('GROUP_ACCESS_DENIED', 'No access to this group'),
  conflict: (message: string) => new AppError('CONFLICT', message),
  internal: (message = 'Internal error') => new AppError('INTERNAL', message),
};
