import { computed, reactive } from 'vue';
import type { Scope } from '@skymatrix/shared-types';
import { ApiError, api } from '../api/client';
import { setApiToken } from '../api/token';
import { decodeToken, isTokenExpired } from '../utils/jwt';

const STORAGE_KEY = 'skymatrix.admin.session';
const ADMIN_SCOPE: Scope = 'admin:users';

export interface AdminSession {
  token: string;
  /** Epoch milliseconds, from the JWT `exp` claim. */
  expiresAt: number;
  userId: string;
  minecraftUuid: string;
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
  if (session) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  else sessionStorage.removeItem(STORAGE_KEY);
}

/**
 * Logs in with a token minted by the Minecraft handshake (the browser cannot
 * obtain one itself — only the game client can). The token is validated against
 * the live API and must carry `admin:users`; everything the UI shows afterwards
 * is re-derived from server responses, never from the token's claims.
 */
export async function loginWithToken(rawToken: string): Promise<AdminSession> {
  const token = rawToken.trim();
  authState.error = null;

  if (!token) throw new Error('请粘贴访问令牌');
  const decoded = decodeToken(token);
  if (!decoded) throw new Error('这不是一个可解析的 JWT，请确认复制完整');
  if (isTokenExpired(token)) throw new Error('令牌已过期，请在游戏内重新登录获取新的令牌');

  authState.loading = true;
  try {
    const [me, permissions] = await Promise.all([api.me(token), api.permissions(token)]);
    const scopes = permissions.scopes;

    if (!scopes.includes(ADMIN_SCOPE)) {
      throw new Error(
        `账号 ${me.user.username}（${me.user.minecraftUuid}）没有 ${ADMIN_SCOPE} 权限。` +
          '请先由已有管理员授权，或在服务器上执行：pnpm --filter @skymatrix/auth-server admin:seed -- --uuid ' +
          me.user.minecraftUuid,
      );
    }

    const session: AdminSession = {
      token,
      expiresAt: decoded.exp * 1000,
      userId: me.user.id,
      minecraftUuid: me.user.minecraftUuid,
      username: me.user.username,
      scopes,
    };
    persist(session);
    return session;
  } catch (error) {
    authState.error = error instanceof ApiError ? error.message : (error as Error).message;
    throw error;
  } finally {
    authState.loading = false;
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
    loginWithToken,
    logout,
  };
}
