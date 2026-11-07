import type {
  AdminActivationCodeRequest,
  AdminActivationCodeResponse,
  AdminBanRequest,
  AdminLinkBanResponse,
  AdminListUsersResponse,
  AdminSessionResponse,
  AdminSetPermissionsRequest,
  AdminStatsResponse,
  AdminUserDetailResponse,
  AdminUserSessionsResponse,
  AuditLogListResponse,
  MeResponse,
  PermissionsResponse,
  PortalTokenResponse,
  StatusResponse,
} from '@hotaru/api-contract';
import { getApiToken } from './token';

/** Late-bound to avoid a circular module initialization between store and client. */
async function refreshApiToken(): Promise<boolean> {
  const { refreshSession } = await import('../stores/auth');
  return refreshSession();
}

const BASE: string = import.meta.env.VITE_API_BASE_URL ?? '';

/** Mirrors the server's documented error envelope. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, retryable: boolean, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }

  /** A 401/403 means the pasted token is stale or lacks the scope. */
  get isAuthProblem(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  token?: string | null;
  signal?: AbortSignal;
  retry?: boolean;
}

type QueryValue = string | number | boolean | undefined | null;

function withQuery(path: string, query: Record<string, QueryValue>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const token = options.token === undefined ? getApiToken() : options.token;
  if (token) headers.authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    throw new ApiError(0, 'NETWORK', `无法连接认证服务：${(error as Error).message}`, true);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }

  if (!response.ok) {
    if (
      response.status === 401 &&
      options.retry !== false &&
      !path.startsWith('/api/v1/portal/') &&
      (await refreshApiToken())
    ) {
      return request<T>(path, { ...options, retry: false });
    }

    const envelope = (payload as { error?: { code?: string; message?: string; retryable?: boolean; details?: unknown } })
      ?.error;
    throw new ApiError(
      response.status,
      envelope?.code ?? 'UNKNOWN',
      envelope?.message ?? `请求失败（HTTP ${response.status}）`,
      envelope?.retryable ?? false,
      envelope?.details,
    );
  }

  return payload as T;
}

export const api = {
  /** Public readiness probe — used by the dashboard's dependency card. */
  healthReady: (signal?: AbortSignal) =>
    request<{ status: 'ok' | 'degraded'; checks: Record<string, 'ok' | 'fail'> }>(
      '/api/v1/health/ready',
      { signal },
    ),

  /** Validates any token (not necessarily admin) and returns the caller. */
  me: (token?: string) => request<MeResponse>('/api/v1/users/me', { token }),

  permissions: (token?: string) =>
    request<PermissionsResponse>('/api/v1/users/me/permissions', { token }),

  /** Password-authenticated admin console session. */
  login: (body: { username: string; password: string; totp?: string }) =>
    request<PortalTokenResponse>('/api/v1/portal/login', { method: 'POST', body, token: null }),

  adminSession: (token?: string) =>
    request<AdminSessionResponse>('/api/v1/portal/admin-session', { token }),

  refresh: (refreshToken: string) =>
    request<PortalTokenResponse>('/api/v1/portal/refresh', {
      method: 'POST',
      body: { refreshToken },
      token: null,
    }),

  /** Public, login-free service snapshot used by /status. */
  status: (signal?: AbortSignal) =>
    request<StatusResponse>('/api/v1/status', { signal, token: null }),

  stats: (signal?: AbortSignal) => request<AdminStatsResponse>('/api/v1/admin/stats', { signal }),

  users: (
    query: { query?: string; status?: 'active' | 'banned'; limit?: number; offset?: number },
    signal?: AbortSignal,
  ) =>
    request<AdminListUsersResponse>(
      withQuery('/api/v1/admin/users', {
        query: query.query,
        status: query.status,
        limit: query.limit,
        offset: query.offset,
      }),
      { signal },
    ),

  user: (id: string, signal?: AbortSignal) =>
    request<AdminUserDetailResponse>(`/api/v1/admin/users/${id}`, { signal }),

  setPermissions: (id: string, body: AdminSetPermissionsRequest) =>
    request<PermissionsResponse>(`/api/v1/admin/users/${id}/permissions`, { method: 'PUT', body }),

  ban: (id: string, body: AdminBanRequest) =>
    request<{ user: MeResponse['user']; sessionsRevoked: number }>(`/api/v1/admin/users/${id}/ban`, {
      method: 'POST',
      body,
    }),

  unban: (id: string) =>
    request<{ user: MeResponse['user'] }>(`/api/v1/admin/users/${id}/unban`, { method: 'POST' }),

  banLink: (userId: string, uuid: string, reason?: string) =>
    request<AdminLinkBanResponse>(`/api/v1/admin/users/${userId}/links/${uuid}/ban`, {
      method: 'POST',
      body: reason ? { reason } : {},
    }),

  unbanLink: (userId: string, uuid: string) =>
    request<AdminLinkBanResponse>(`/api/v1/admin/users/${userId}/links/${uuid}/unban`, {
      method: 'POST',
    }),

  issueActivationCode: (body: AdminActivationCodeRequest) =>
    request<AdminActivationCodeResponse>('/api/v1/admin/activation-codes', {
      method: 'POST',
      body,
    }),

  sessions: (
    userId: string,
    query: { limit?: number; offset?: number; includeRevoked?: boolean } = {},
    signal?: AbortSignal,
  ) =>
    request<AdminUserSessionsResponse>(
      withQuery(`/api/v1/admin/users/${userId}/sessions`, {
        limit: query.limit,
        offset: query.offset,
        includeRevoked: query.includeRevoked === undefined ? undefined : String(query.includeRevoked),
      }),
      { signal },
    ),

  revokeSession: (sessionId: string, reason?: string) =>
    request<{ session: { id: string } }>(`/api/v1/admin/sessions/${sessionId}/revoke`, {
      method: 'POST',
      body: reason ? { reason } : {},
    }),

  auditLogs: (
    query: { event?: string; actorId?: string; limit?: number; offset?: number },
    signal?: AbortSignal,
  ) =>
    request<AuditLogListResponse>(
      withQuery('/api/v1/admin/audit-logs', {
        event: query.event,
        actorId: query.actorId,
        limit: query.limit,
        offset: query.offset,
      }),
      { signal },
    ),
};
