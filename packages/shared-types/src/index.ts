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

export const SCOPE_DESCRIPTIONS: Record<Scope, string> = {
  'hotaru:profile': 'Read the authenticated account profile',
  'hotaru:resource': 'Access the Hotaru mod resource service',
  'hotaru:ircserver': 'Connect to the Hotaru IRC service',
  'hotaru:license': 'Query software licenses',
  'admin:users': 'Administer users, permissions and sessions',
};

export type UserStatus = 'active' | 'banned';

export interface MinecraftProfile {
  /** Canonical, undashed-then-dashed Mojang UUID (36 chars, lowercase, hyphens). */
  uuid: string;
  username: string;
}

export interface UserView {
  id: string;
  minecraftUuid: string;
  username: string;
  status: UserStatus;
  createdAt: string;
  lastLoginAt: string | null;
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
