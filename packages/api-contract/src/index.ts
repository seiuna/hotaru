import { z } from 'zod';
import { SCOPES, ERROR_CODES } from '@skymatrix/shared-types';

export * from '@skymatrix/shared-types';

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
  minecraftUuid: minecraftUuidSchema,
  username: z.string(),
  status: z.enum(['active', 'banned']),
  createdAt: z.string(),
  lastLoginAt: z.string().nullable(),
});

export const permissionViewSchema = z.object({
  scope: scopeSchema,
  grantedAt: z.string(),
  expiresAt: z.string().nullable(),
  grantedBy: z.string().nullable(),
});

export const meResponseSchema = z.object({
  user: userViewSchema,
  scopes: z.array(scopeSchema),
});

export const permissionsResponseSchema = z.object({
  permissions: z.array(permissionViewSchema),
  /** Effective scopes: granted, unexpired, and allowed. */
  scopes: z.array(scopeSchema),
});

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

export const healthLiveResponseSchema = z.object({
  status: z.literal('ok'),
  uptimeSeconds: z.number().int().nonnegative(),
});

export const healthReadyResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  checks: z.record(z.enum(['ok', 'fail'])),
});
