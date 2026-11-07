import { z } from 'zod';
import {
  auditLogListResponseSchema,
  auditLogViewSchema,
  sessionViewSchema,
  userViewSchema,
} from '@hotaru/api-contract';

/**
 * Response schemas that the shared contract does not define. They mirror
 * `@hotaru/shared-types` so the OpenAPI document generated from these routes
 * stays truthful.
 *
 * `sessionViewSchema` and the audit-log schemas now live in
 * `@hotaru/api-contract` because the admin web app consumes the same shapes;
 * they are re-exported here so existing imports keep working.
 */
export { sessionViewSchema, auditLogViewSchema, auditLogListResponseSchema };
export type SessionView = z.infer<typeof sessionViewSchema>;
export type AuditLogView = z.infer<typeof auditLogViewSchema>;
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
