import { computed, reactive } from 'vue';
import type { Scope } from '@hotaru/shared-types';
import { ApiError, api } from '../api/client';
import { setApiToken } from '../api/token';
import { decodeToken, isTokenExpired } from '../utils/jwt';

const STORAGE_KEY = 'hotaru.admin.session';
const REFRESH_KEY = 'hotaru.admin.refresh';
const ADMIN_SCOPE: Scope = 'admin:users';

export interface AdminSession {
  token: string;
  refreshToken: string | null;
  /** Epoch milliseconds, from the JWT `exp` claim. */
  expiresAt: number;
  userId: string;
  minecraftUuid: string | null;
  username: string;
  scopes: Scope[];
}

interface AuthState {
  session: AdminSession | null;
  loading: boolean;
  error: string | null;
}

function loadStoredSession(): AdminSession | null {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AdminSession;
    if (!parsed?.token || isTokenExpired(parsed.token)) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

const initialSession = loadStoredSession();
setApiToken(initialSession?.token ?? null);

export const authState = reactive<AuthState>({
  session: initialSession,
  loading: false,
  error: null,
});

function persist(session: AdminSession | null): void {
  authState.session = session;
  setApiToken(session?.token ?? null);
  if (session) {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    if (session.refreshToken) sessionStorage.setItem(REFRESH_KEY, session.refreshToken);
    else sessionStorage.removeItem(REFRESH_KEY);
  } else {
    sessionStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(REFRESH_KEY);
  }
}

/**
 * Password login for the console. The account must have `admin:users`; the
 * server's scope guard enforces it again on every admin API request.
 */
export async function loginWithPassword(credentials: {
  username: string;
  password: string;
  totp?: string;
}): Promise<AdminSession> {
  authState.error = null;
  authState.loading = true;
  try {
    const tokens = await api.login(credentials);
    const session = await api.adminSession(tokens.accessToken);
    if (!session.scopes.includes(ADMIN_SCOPE)) {
      throw new Error(`账号 ${session.account.username} 没有 ${ADMIN_SCOPE} 权限，无法进入控制台。`);
    }

    const decoded = decodeToken(tokens.accessToken);
    if (!decoded) throw new Error('服务端返回的访问令牌无效');
    const next: AdminSession = {
      token: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: decoded.exp * 1000,
      userId: session.account.id,
      minecraftUuid: session.account.links[0]?.uuid ?? null,
      username: session.account.username,
      scopes: session.scopes,
    };
    persist(next);
    return next;
  } catch (error) {
    authState.error = error instanceof ApiError ? error.message : (error as Error).message;
    throw error;
  } finally {
    authState.loading = false;
  }
}

export async function refreshSession(): Promise<boolean> {
  const refreshToken = sessionStorage.getItem(REFRESH_KEY);
  const current = authState.session;
  if (!refreshToken || !current) return false;
  try {
    const tokens = await api.refresh(refreshToken);
    const decoded = decodeToken(tokens.accessToken);
    if (!decoded) throw new Error('服务端返回的访问令牌无效');
    persist({
      ...current,
      token: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: decoded.exp * 1000,
    });
    return true;
  } catch {
    persist(null);
    return false;
  }
}

export function logout(): void {
  persist(null);
}

export function clearSessionIfExpired(): boolean {
  if (authState.session && isTokenExpired(authState.session.token)) {
    persist(null);
    return true;
  }
  return false;
}

/** Merges freshly loaded scopes (e.g. after an admin edits their own grants). */
export function setScopes(scopes: Scope[]): void {
  if (!authState.session) return;
  persist({ ...authState.session, scopes });
}

export function useAuth() {
  return {
    state: authState,
    session: computed(() => authState.session),
    isAuthenticated: computed(() => Boolean(authState.session) && !isTokenExpired(authState.session?.token ?? '')),
    isAdmin: computed(() => authState.session?.scopes.includes(ADMIN_SCOPE) ?? false),
    secondsUntilExpiry: computed(() => {
      if (!authState.session) return 0;
      return Math.max(0, Math.round((authState.session.expiresAt - Date.now()) / 1000));
    }),
    loginWithPassword,
    logout,
  };
}
