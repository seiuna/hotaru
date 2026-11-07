/**
 * Browser side of the local authentication bridge.
 *
 * The Minecraft mod listens on loopback (default 127.0.0.1:8765). This module probes it, asks it for a
 * token, and maps every failure mode onto something the login screen can explain:
 *
 *   unavailable -> the mod is not running / the port is closed
 *   blocked     -> the bridge refused this page's origin (not on the mod's allowlist)
 *   denied      -> the player said "no" in the in-game prompt
 *   timeout     -> nobody answered the in-game prompt in time
 *   failed      -> the game could not complete the Mojang handshake
 *
 * Security: the token returned here is a bearer credential. It is handed straight to the auth store
 * (sessionStorage) and never logged, never put in a URL.
 */

export const DEFAULT_BRIDGE_PORT = 8765;

export type BridgeFailureKind = 'unavailable' | 'blocked' | 'denied' | 'timeout' | 'failed';

export class BridgeError extends Error {
  readonly kind: BridgeFailureKind;
  readonly code: string;

  constructor(kind: BridgeFailureKind, code: string, message: string) {
    super(message);
    this.name = 'BridgeError';
    this.kind = kind;
    this.code = code;
  }
}

export interface BridgeToken {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
  profile: { uuid: string; username: string };
  scopes: string[];
}

export interface BridgeOptions {
  port?: number;
  /** How long the health probe may take before we call the bridge absent. */
  probeTimeoutMs?: number;
  /** How long we wait for the player's in-game approval. */
  approvalTimeoutMs?: number;
}

interface BridgeErrorBody {
  error?: { code?: string; message?: string };
}

function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asBridgeToken(payload: unknown): BridgeToken {
  const value = payload as Partial<BridgeToken> | null;
  const profile = value?.profile as { uuid?: unknown; username?: unknown } | undefined;
  if (
    typeof value?.accessToken !== 'string' ||
    typeof value.refreshToken !== 'string' ||
    typeof value.expiresIn !== 'number' ||
    typeof profile?.uuid !== 'string' ||
    typeof profile.username !== 'string' ||
    !Array.isArray(value.scopes)
  ) {
    throw new BridgeError('failed', 'INVALID_RESPONSE', '本地 Mod 返回的数据不完整，请更新模组版本');
  }
  return {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    tokenType: typeof value.tokenType === 'string' ? value.tokenType : 'Bearer',
    expiresIn: value.expiresIn,
    profile: { uuid: profile.uuid, username: profile.username },
    scopes: value.scopes as string[],
  };
}

/** `true` when a bridge answers on the port (used to decide whether to show the button as available). */
export async function probeLocalBridge(options: BridgeOptions = {}): Promise<boolean> {
  const port = options.port ?? DEFAULT_BRIDGE_PORT;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.probeTimeoutMs ?? 1500);
  try {
    const response = await fetch(`${baseUrl(port)}/v1/health`, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) return false;
    const payload = (await readJson(response)) as { ok?: boolean; service?: string } | null;
    return payload?.ok === true && payload?.service === 'hotaru-local-auth';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asks the running mod for a token. Blocks while the player confirms in game.
 *
 * Chromium will send a Private Network Access preflight first; the bridge answers it. If the browser
 * blocks the request outright the fetch rejects and we report `unavailable` with an actionable hint.
 */
export async function loginViaLocalBridge(options: BridgeOptions = {}): Promise<BridgeToken> {
  const port = options.port ?? DEFAULT_BRIDGE_PORT;
  const reachable = await probeLocalBridge({ ...options, port });
  if (!reachable) {
    throw new BridgeError(
      'unavailable',
      'BRIDGE_UNREACHABLE',
      `未检测到本地认证服务（127.0.0.1:${port}）。请确认游戏已启动、已安装 Hotaru 模组，且未被防火墙拦截。`,
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.approvalTimeoutMs ?? 65_000);
  try {
    const response = await fetch(`${baseUrl(port)}/v1/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
    });

    const payload = (await readJson(response)) as BridgeErrorBody | null;

    if (response.ok) return asBridgeToken(payload);

    const code = payload?.error?.code ?? 'UNKNOWN';
    switch (code) {
      case 'ORIGIN_NOT_ALLOWED':
        throw new BridgeError(
          'blocked',
          code,
          '本地 Mod 未授权当前站点。请把本站地址加入模组配置的允许来源（allowedOrigins）。',
        );
      case 'APPROVAL_DENIED':
        throw new BridgeError('denied', code, '你已在游戏内拒绝本次登录。');
      case 'APPROVAL_TIMEOUT':
        throw new BridgeError('timeout', code, '游戏内确认超时，请重试并在聊天栏确认。');
      case 'RATE_LIMITED':
        throw new BridgeError('failed', code, '登录尝试过于频繁，请等待一分钟后重试。');
      case 'MINT_FAILED':
        throw new BridgeError('failed', code, '游戏内无法完成 Mojang 正版校验，请确认游戏会话有效。');
      default:
        throw new BridgeError('failed', code, payload?.error?.message ?? '本地认证失败，请重试。');
    }
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new BridgeError('timeout', 'ABORTED', '等待游戏内确认超时，请重试。');
    }
    throw new BridgeError(
      'unavailable',
      'NETWORK',
      '浏览器阻止了访问本地端口的请求。请允许本站访问本地网络，或改用粘贴令牌登录。',
    );
  } finally {
    clearTimeout(timer);
  }
}
