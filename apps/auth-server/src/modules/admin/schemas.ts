import { z } from 'zod';
import { objectIdSchema, userViewSchema } from '@skymatrix/api-contract';

/**
 * Response schemas that the shared contract does not define yet. They mirror
 * `@skymatrix/shared-types` (`SessionView`, `AuditLogView`) so the OpenAPI
 * document generated from these routes stays truthful.
 */

export const sessionViewSchema = z.object({
  id: objectIdSchema,
  createdAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
});
export type SessionView = z.infer<typeof sessionViewSchema>;

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

/** Ban additionally reports how many sessions the revocation fan-out killed. */
export const adminBanResponseSchema = z.object({
  user: userViewSchema,
  sessionsRevoked: z.number().int().nonnegative(),
});
export type AdminBanResponse = z.infer<typeof adminBanResponseSchema>;

export const adminUnbanResponseSchema = z.object({
  user: userViewSchema,
});
export type AdminUnbanResponse = z.infer<typeof adminUnbanResponseSchema>;

export const adminRevokeSessionResponseSchema = z.object({
  session: sessionViewSchema,
});
export type AdminRevokeSessionResponse = z.infer<typeof adminRevokeSessionResponseSchema>;
