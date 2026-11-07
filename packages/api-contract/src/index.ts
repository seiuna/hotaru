import { z } from 'zod';
import { SCOPES, ERROR_CODES } from '@hotaru/shared-types';

export * from '@hotaru/shared-types';

/* ------------------------------------------------------------------ */
/* Shared primitives                                                   */
/* ------------------------------------------------------------------ */

/** Minecraft usernames are 3-16 chars of [A-Za-z0-9_]. */
export const usernameSchema = z
  .string()
  .min(3)
  .max(16)
  .regex(/^[A-Za-z0-9_]+$/, 'username must be 3-16 characters of A-Za-z0-9_');

/** Mojang UUID in canonical dashed lowercase form. */
export const minecraftUuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'invalid UUID');

export const objectIdSchema = z
  .string()
  .regex(/^[0-9a-f]{24}$/, 'invalid id');

export const scopeSchema = z.enum(SCOPES);

export const errorCodeSchema = z.enum(ERROR_CODES);

export const errorResponseSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    retryable: z.boolean(),
    details: z.unknown().optional(),
  }),
});

/* ------------------------------------------------------------------ */
/* Minecraft authentication                                            */
/* ------------------------------------------------------------------ */

export const challengeRequestSchema = z.object({
  username: usernameSchema,
  client: z.literal('fabric').default('fabric'),
});
export type ChallengeRequest = z.infer<typeof challengeRequestSchema>;

export const challengeResponseSchema = z.object({
  challengeId: z.string().uuid(),
  /** Random per-challenge server id; also the salt in the Mojang server hash. */
  serverId: z.string().min(1),
  /** Base64 DER (X.509 SubjectPublicKeyInfo) of the server RSA public key. */
  publicKey: z.string().min(1),
  /** Base64 random nonce the client must RSA-encrypt and echo back. */
  verifyToken: z.string().min(1),
  expiresIn: z.number().int().positive(),
});
export type ChallengeResponse = z.infer<typeof challengeResponseSchema>;

export const verifyRequestSchema = z.object({
  challengeId: z.string().uuid(),
  username: usernameSchema,
  /** RSA/PKCS#1 v1.5 encrypted shared secret, base64. */
  encryptedSharedSecret: z.string().min(1).max(2048),
  /** RSA/PKCS#1 v1.5 encrypted verify token, base64. */
  encryptedVerifyToken: z.string().min(1).max(2048),
});
export type VerifyRequest = z.infer<typeof verifyRequestSchema>;

export const tokenResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().positive(),
  profile: z.object({
    uuid: minecraftUuidSchema,
    username: z.string(),
  }),
  scopes: z.array(scopeSchema),
});
export type TokenResponse = z.infer<typeof tokenResponseSchema>;

export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(20).max(512),
});
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

export const jwksResponseSchema = z.object({
  keys: z.array(z.record(z.unknown())),
});

/* ------------------------------------------------------------------ */
/* Users & permissions                                                 */
/* ------------------------------------------------------------------ */

export const userViewSchema = z.object({
  id: objectIdSchema,
  minecraftUuid: minecraftUuidSchema.nullable(),
  email: z.string().nullable(),
  username: z.string(),
  status: z.enum(['active', 'banned']),
  createdAt: z.string(),
  lastLoginAt: z.string().nullable(),
});
export type UserView = z.infer<typeof userViewSchema>;

export const minecraftLinkViewSchema = z.object({
  uuid: minecraftUuidSchema,
  username: z.string(),
  status: z.enum(['active', 'banned']),
  linkedAt: z.string(),
});
export type MinecraftLinkView = z.infer<typeof minecraftLinkViewSchema>;

export const accountViewSchema = z.object({
  id: objectIdSchema,
  username: z.string(),
  loginName: z.string(),
  email: z.string().nullable(),
  status: z.enum(['active', 'banned']),
  twoFactorEnabled: z.boolean(),
  createdAt: z.string(),
  links: z.array(minecraftLinkViewSchema),
});
export type AccountView = z.infer<typeof accountViewSchema>;

export const adminLinkBanResponseSchema = z.object({
  link: minecraftLinkViewSchema,
  sessionsRevoked: z.number().int().nonnegative(),
});
export type AdminLinkBanResponse = z.infer<typeof adminLinkBanResponseSchema>;

export const permissionViewSchema = z.object({
  scope: scopeSchema,
  grantedAt: z.string(),
  expiresAt: z.string().nullable(),
  grantedBy: z.string().nullable(),
});
export type PermissionView = z.infer<typeof permissionViewSchema>;

export const meResponseSchema = z.object({
  user: userViewSchema,
  scopes: z.array(scopeSchema),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const permissionsResponseSchema = z.object({
  permissions: z.array(permissionViewSchema),
  /** Effective scopes: granted, unexpired, and allowed. */
  scopes: z.array(scopeSchema),
});
export type PermissionsResponse = z.infer<typeof permissionsResponseSchema>;

/* ------------------------------------------------------------------ */
/* User portal                                                         */
/* ------------------------------------------------------------------ */

/** Platform login name; case-insensitive, normalized to lower-case by the server. */
export const accountNameSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[A-Za-z0-9_.-]+$/, 'login name must be 3-32 characters of A-Za-z0-9_.-');

export const accountPasswordSchema = z.string().min(10).max(128);

export const emailSchema = z.string().email().max(254);

export const activateAccountRequestSchema = z.object({
  code: z.string().min(20).max(2048),
  username: accountNameSchema,
  password: accountPasswordSchema,
  email: emailSchema.optional(),
});
export type ActivateAccountRequest = z.infer<typeof activateAccountRequestSchema>;

export const claimAccountRequestSchema = z.object({
  code: z.string().min(20).max(2048),
  username: accountNameSchema,
  password: accountPasswordSchema,
  email: emailSchema.optional(),
});
export type ClaimAccountRequest = z.infer<typeof claimAccountRequestSchema>;

export const portalLoginRequestSchema = z.object({
  username: accountNameSchema,
  password: z.string().min(1).max(128),
  totp: z.string().regex(/^\d{6}$/).optional(),
});
export type PortalLoginRequest = z.infer<typeof portalLoginRequestSchema>;

export const portalTokenResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().positive(),
  account: accountViewSchema,
});
export type PortalTokenResponse = z.infer<typeof portalTokenResponseSchema>;

export const portalRefreshRequestSchema = z.object({
  refreshToken: z.string().min(20).max(512),
});
export type PortalRefreshRequest = z.infer<typeof portalRefreshRequestSchema>;

export const portalMeResponseSchema = z.object({
  account: accountViewSchema,
});
export type PortalMeResponse = z.infer<typeof portalMeResponseSchema>;

export const portalBindRequestSchema = z.object({
  code: z.string().min(4).max(2048),
});
export type PortalBindRequest = z.infer<typeof portalBindRequestSchema>;

export const portalUnbindRequestSchema = z.object({
  uuid: minecraftUuidSchema,
});
export type PortalUnbindRequest = z.infer<typeof portalUnbindRequestSchema>;

export const portalChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: accountPasswordSchema,
});
export type PortalChangePasswordRequest = z.infer<typeof portalChangePasswordRequestSchema>;

export const portalEmailChangeRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});
export type PortalEmailChangeRequest = z.infer<typeof portalEmailChangeRequestSchema>;

export const portalForgotPasswordRequestSchema = z.object({
  email: emailSchema,
});
export type PortalForgotPasswordRequest = z.infer<typeof portalForgotPasswordRequestSchema>;

export const portalResetPasswordRequestSchema = z.object({
  token: z.string().min(20).max(512),
  newPassword: accountPasswordSchema,
});
export type PortalResetPasswordRequest = z.infer<typeof portalResetPasswordRequestSchema>;

export const portalTotpSetupResponseSchema = z.object({
  secret: z.string(),
  otpauthUri: z.string(),
});
export type PortalTotpSetupResponse = z.infer<typeof portalTotpSetupResponseSchema>;

export const portalTotpEnableRequestSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
});
export type PortalTotpEnableRequest = z.infer<typeof portalTotpEnableRequestSchema>;

export const portalTotpDisableRequestSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  code: z.string().regex(/^\d{6}$/).optional(),
});
export type PortalTotpDisableRequest = z.infer<typeof portalTotpDisableRequestSchema>;

export const adminActivationCodeRequestSchema = z.object({
  type: z.enum(['account', 'bind', 'claim']),
  expiresInSeconds: z.coerce.number().int().min(60).max(60 * 60 * 24 * 365).default(7 * 24 * 60 * 60),
  uuid: minecraftUuidSchema.optional(),
  username: z.string().min(1).max(64).optional(),
});
export type AdminActivationCodeRequest = z.infer<typeof adminActivationCodeRequestSchema>;

export const adminActivationCodeResponseSchema = z.object({
  code: z.string(),
  type: z.enum(['account', 'bind', 'claim']),
  expiresAt: z.string(),
});
export type AdminActivationCodeResponse = z.infer<typeof adminActivationCodeResponseSchema>;

/* ------------------------------------------------------------------ */
/* Admin                                                               */
/* ------------------------------------------------------------------ */

export const adminListUsersQuerySchema = z.object({
  query: z.string().max(64).optional(),
  status: z.enum(['active', 'banned']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const adminListUsersResponseSchema = z.object({
  users: z.array(userViewSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type AdminListUsersResponse = z.infer<typeof adminListUsersResponseSchema>;

export const permissionGrantSchema = z.object({
  scope: scopeSchema,
  expiresAt: z.string().datetime().nullable().optional(),
});

export const adminSetPermissionsSchema = z.object({
  permissions: z.array(permissionGrantSchema).max(32),
});
export type AdminSetPermissionsRequest = z.infer<typeof adminSetPermissionsSchema>;

export const adminBanSchema = z.object({
  reason: z.string().max(500).optional(),
});
export type AdminBanRequest = z.infer<typeof adminBanSchema>;

export const adminRevokeSessionSchema = z.object({
  reason: z.string().max(500).optional(),
});

export const auditListQuerySchema = z.object({
  event: z.string().max(64).optional(),
  actorId: objectIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** One login session, as shown in the admin UI. */
export const sessionViewSchema = z.object({
  id: objectIdSchema,
  createdAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
});
export type SessionView = z.infer<typeof sessionViewSchema>;

export const adminUserSessionsResponseSchema = z.object({
  sessions: z.array(sessionViewSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type AdminUserSessionsResponse = z.infer<typeof adminUserSessionsResponseSchema>;

/** Dashboard counters. Cheap aggregate queries, no per-row secrets. */
export const adminStatsResponseSchema = z.object({
  users: z.object({
    total: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    banned: z.number().int().nonnegative(),
  }),
  sessions: z.object({
    active: z.number().int().nonnegative(),
  }),
  permissions: z.object({
    total: z.number().int().nonnegative(),
  }),
  audit: z.object({
    last24h: z.number().int().nonnegative(),
  }),
  generatedAt: z.string(),
});
export type AdminStatsResponse = z.infer<typeof adminStatsResponseSchema>;

export const adminUserSessionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  includeRevoked: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

/** Everything the user-detail screen needs in one round trip. */
export const adminUserDetailResponseSchema = z.object({
  user: userViewSchema,
  permissions: z.array(permissionViewSchema),
  scopes: z.array(scopeSchema),
  links: z.array(minecraftLinkViewSchema),
});
export type AdminUserDetailResponse = z.infer<typeof adminUserDetailResponseSchema>;

export const adminSessionResponseSchema = z.object({
  account: accountViewSchema,
  scopes: z.array(scopeSchema),
});
export type AdminSessionResponse = z.infer<typeof adminSessionResponseSchema>;

export const serviceStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(['up', 'degraded', 'down']),
  latencyMs: z.number().nonnegative().nullable(),
  detail: z.string().nullable(),
});
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;

export const statusResponseSchema = z.object({
  generatedAt: z.string(),
  services: z.array(serviceStatusSchema),
});
export type StatusResponse = z.infer<typeof statusResponseSchema>;

export const auditLogViewSchema = z.object({
  id: objectIdSchema,
  event: z.string(),
  actorId: z.string().nullable(),
  actorType: z.enum(['user', 'admin', 'system']),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  ip: z.string().nullable(),
  metadata: z.record(z.unknown()).nullable(),
  createdAt: z.string(),
});
export type AuditLogView = z.infer<typeof auditLogViewSchema>;

export const auditLogListResponseSchema = z.object({
  logs: z.array(auditLogViewSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type AuditLogListResponse = z.infer<typeof auditLogListResponseSchema>;

export const healthLiveResponseSchema = z.object({
  status: z.literal('ok'),
  uptimeSeconds: z.number().int().nonnegative(),
});

export const healthReadyResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  checks: z.record(z.enum(['ok', 'fail'])),
});
