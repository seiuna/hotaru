import type { AccountView } from './types';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';
const TOKEN_KEY = 'hotaru.portal.session';

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

export function setToken(token: string | null): void {
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  else sessionStorage.removeItem(TOKEN_KEY);
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
}

async function request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers({ accept: 'application/json' });
  const token = getToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (options.body !== undefined) headers.set('content-type', 'application/json');

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${endpoint}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch (error) {
    throw new ApiError(`无法连接服务：${(error as Error).message}`, 'NETWORK', 0);
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

export const portalApi = {
  activate: (body: { code: string; username: string; password: string }) =>
    request<AccountView>('/api/v1/portal/activate', { method: 'POST', body }),
  login: (body: { username: string; password: string }) =>
    request<{ accessToken: string; account: AccountView }>('/api/v1/portal/login', {
      method: 'POST',
      body,
    }),
  me: () => request<{ account: AccountView }>('/api/v1/portal/me'),
  bind: (code: string) =>
    request<{ account: AccountView }>('/api/v1/portal/bind', { method: 'POST', body: { code } }),
  unbind: (uuid: string) =>
    request<{ account: AccountView }>('/api/v1/portal/unbind', { method: 'POST', body: { uuid } }),
  password: (body: { currentPassword: string; newPassword: string }) =>
    request<void>('/api/v1/portal/password', { method: 'POST', body }),
};
