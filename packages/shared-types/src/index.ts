/**
 * Domain types shared by every Hotaru service.
 * Pure types only — no runtime dependencies, no vendor lock-in.
 */

export const SCOPES = [
  'hotaru:profile',
  'hotaru:resource',
  'hotaru:ircserver',
  'hotaru:license',
  'admin:users',
] as const;

export type Scope = (typeof SCOPES)[number];

/** Scopes carried by a user-portal token. These never grant game or IRC access. */
export const PORTAL_SCOPES = ['portal:account', 'portal:link'] as const;

export type PortalScope = (typeof PORTAL_SCOPES)[number];

export const SCOPE_DESCRIPTIONS: Record<Scope, string> = {
  'hotaru:profile': 'Read the authenticated account profile',
  'hotaru:resource': 'Access the Hotaru mod resource service',
  'hotaru:ircserver': 'Connect to the Hotaru IRC service',
  'hotaru:license': 'Query software licenses',
  'admin:users': 'Administer users, permissions and sessions',
};

export type UserStatus = 'active' | 'banned';
export type MinecraftLinkStatus = 'active' | 'banned';

export interface MinecraftProfile {
  /** Canonical, undashed-then-dashed Mojang UUID (36 chars, lowercase, hyphens). */
  uuid: string;
  username: string;
}

export interface MinecraftLinkView {
  uuid: string;
  username: string;
  status: MinecraftLinkStatus;
  linkedAt: string;
}

export interface UserView {
  id: string;
  /** Primary UUID kept for the existing admin list; null for an account with no links. */
  minecraftUuid: string | null;
  username: string;
  status: UserStatus;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface AccountView {
  id: string;
  username: string;
  loginName: string;
  status: UserStatus;
  createdAt: string;
  links: MinecraftLinkView[];
}

export interface PermissionView {
  scope: Scope;
  grantedAt: string;
  expiresAt: string | null;
  grantedBy: string | null;
}

export interface SessionView {
  id: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  ip: string | null;
  userAgent: string | null;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  /** Access token lifetime in seconds. */
  expiresIn: number;
  profile: MinecraftProfile;
  scopes: Scope[];
}

export type AuditEvent =
  | 'auth.challenge.created'
  | 'auth.challenge.rejected'
  | 'auth.session.created'
  | 'auth.session.refreshed'
  | 'auth.session.revoked'
  | 'auth.refresh.reused'
  | 'auth.login.banned'
  | 'auth.link.required'
  | 'account.activated'
  | 'account.login'
  | 'account.password.changed'
  | 'account.link.created'
  | 'account.link.removed'
  | 'account.link.banned'
  | 'account.link.unbanned'
  | 'user.permissions.updated'
  | 'user.banned'
  | 'user.unbanned'
  | 'admin.seeded';

export interface AuditLogView {
  id: string;
  event: AuditEvent;
  actorId: string | null;
  actorType: 'user' | 'admin' | 'system';
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/** Machine-readable API error codes. Stable: clients may branch on these. */
export const ERROR_CODES = [
  'INVALID_REQUEST',
  'CHALLENGE_NOT_FOUND',
  'CHALLENGE_EXPIRED',
  'CHALLENGE_CONSUMED',
  'NOT_A_PREMIUM_SESSION',
  'MOJANG_UNAVAILABLE',
  'RATE_LIMITED',
  'UNAUTHORIZED',
  'TOKEN_EXPIRED',
  'SESSION_REVOKED',
  'REFRESH_REUSED',
  'USER_BANNED',
  'UUID_BANNED',
  'LINK_REQUIRED',
  'LINK_ALREADY_BOUND',
  'LINK_CODE_INVALID',
  'LINK_CODE_EXPIRED',
  'INVALID_CREDENTIALS',
  'ACCOUNT_EXISTS',
  'ACTIVATION_DISABLED',
  'ACTIVATION_INVALID',
  'ACTIVATION_EXPIRED',
  'ACTIVATION_USED',
  'PASSWORD_POLICY',
  'FORBIDDEN',
  'NOT_FOUND',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    details?: unknown;
  };
}

/** JWT access-token payload. `sub` is the internal user id, never the Mojang UUID. */
export interface AccessTokenClaims {
  iss: string;
  sub: string;
  aud: string[];
  minecraft_uuid: string;
  sid: string;
  jti: string;
  scope: string;
  iat: number;
  exp: number;
}

/** User-portal token. It deliberately has no Minecraft UUID claim. */
export interface PortalTokenClaims {
  iss: string;
  sub: string;
  aud: string[];
  sid: string;
  jti: string;
  scope: string;
  iat: number;
  exp: number;
}
