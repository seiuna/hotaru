import type { AccountView } from './types';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';
const TOKEN_KEY = 'hotaru.portal.session';
const REFRESH_KEY = 'hotaru.portal.refresh';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  return sessionStorage.getItem(REFRESH_KEY);
}

export function setTokens(accessToken: string | null, refreshToken: string | null): void {
  if (accessToken) sessionStorage.setItem(TOKEN_KEY, accessToken);
  else sessionStorage.removeItem(TOKEN_KEY);
  if (refreshToken) sessionStorage.setItem(REFRESH_KEY, refreshToken);
  else sessionStorage.removeItem(REFRESH_KEY);
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  auth?: boolean;
  retry?: boolean;
}

interface TokenEnvelope {
  accessToken: string;
  refreshToken: string;
  account: AccountView;
}

async function rawRequest<T>(endpoint: string, options: RequestOptions): Promise<T> {
  const headers = new Headers({ accept: 'application/json' });
  const token = getToken();
  if (token && options.auth !== false) headers.set('authorization', `Bearer ${token}`);
  if (options.body !== undefined) headers.set('content-type', 'application/json');

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${endpoint}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch (error) {
    throw new ApiError(`无法连接服务�?{(error as Error).message}`, 'NETWORK', 0);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const envelope = payload as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(
      envelope?.error?.message ?? `请求失败（HTTP ${response.status}）`,
      envelope?.error?.code ?? 'UNKNOWN',
      response.status,
    );
  }
  return payload as T;
}

async function request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
  try {
    return await rawRequest<T>(endpoint, options);
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 401 &&
      options.retry !== false &&
      endpoint !== '/api/v1/portal/refresh' &&
      getRefreshToken()
    ) {
      try {
        const refreshed = await rawRequest<TokenEnvelope>('/api/v1/portal/refresh', {
          method: 'POST',
          body: { refreshToken: getRefreshToken() },
          auth: false,
          retry: false,
        });
        setTokens(refreshed.accessToken, refreshed.refreshToken);
        return await rawRequest<T>(endpoint, { ...options, retry: false });
      } catch {
        setTokens(null, null);
        throw error;
      }
    }
    throw error;
  }
}

export const portalApi = {
  activate: (body: { code: string; username: string; password: string; email?: string }) =>
    request<AccountView>('/api/v1/portal/activate', { method: 'POST', body, auth: false, retry: false }),
  claim: (body: { code: string; username: string; password: string; email?: string }) =>
    request<AccountView>('/api/v1/portal/claim', { method: 'POST', body, auth: false, retry: false }),
  login: (body: { username: string; password: string; totp?: string }) =>
    request<TokenEnvelope>('/api/v1/portal/login', { method: 'POST', body, auth: false, retry: false }),
  me: () => request<{ account: AccountView }>('/api/v1/portal/me'),
  bind: (code: string) =>
    request<{ account: AccountView }>('/api/v1/portal/bind', { method: 'POST', body: { code } }),
  unbind: (uuid: string) =>
    request<{ account: AccountView }>('/api/v1/portal/unbind', { method: 'POST', body: { uuid } }),
  password: (body: { currentPassword: string; newPassword: string }) =>
    request<void>('/api/v1/portal/password', { method: 'POST', body }),
  email: (body: { email: string; password: string }) =>
    request<{ account: AccountView }>('/api/v1/portal/email', { method: 'POST', body }),
  forgot: (email: string) =>
    request<void>('/api/v1/portal/forgot-password', { method: 'POST', body: { email }, auth: false, retry: false }),
  reset: (body: { token: string; newPassword: string }) =>
    request<void>('/api/v1/portal/reset-password', { method: 'POST', body, auth: false, retry: false }),
  totpSetup: () =>
    request<{ secret: string; otpauthUri: string }>('/api/v1/portal/2fa/setup', { method: 'POST' }),
  totpEnable: (code: string) =>
    request<{ account: AccountView }>('/api/v1/portal/2fa/enable', {
      method: 'POST',
      body: { code },
    }),
  totpDisable: (body: { currentPassword: string; code?: string }) =>
    request<{ account: AccountView }>('/api/v1/portal/2fa/disable', { method: 'POST', body }),
};
