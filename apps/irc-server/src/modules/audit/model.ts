import mongoose, { type Model } from 'mongoose';

/**
 * `irc_audit_logs` (design §11.5): the security trail for groups, filters and
 * messaging decisions.
 *
 * Two rules shape this collection:
 *
 * - **Identifiers and decisions only.** There is no field for a chat payload, and
 *   `metadata` is sanitised on write (`audit/service.ts`) so a caller cannot smuggle
 *   one in. An audit record that contained the message would turn a log with a
 *   30-day retention into a content archive.
 * - **Retention is a TTL, not a delete job.** 30 days, deleted lazily by MongoDB;
 *   an audit row can therefore outlive a group or a session, which is the point of
 *   an audit log.
 *
 * Note the default `mongoose` import: mongoose is CJS, and `models` is not one of
 * the statically detectable named exports, so `import { models } from 'mongoose'`
 * type-checks but throws at runtime in ESM.
 */

export const AUDIT_RETENTION_SECONDS = 60 * 60 * 24 * 30;

export interface IrcAuditLogDoc {
  event: string;
  /** Mojang UUID of the actor (canonical dashed lowercase), or null for system events. */
  actorUuid: string | null;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  /** Bounded, sanitised identifiers — never message content. */
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

const auditLogSchema = new mongoose.Schema(
  {
    event: { type: String, required: true },
    actorUuid: { type: String, default: null },
    targetType: { type: String, default: null },
    targetId: { type: String, default: null },
    ip: { type: String, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  {
    // No updatedAt: an audit row is immutable once written.
    timestamps: { createdAt: true, updatedAt: false },
    collection: 'irc_audit_logs',
    versionKey: false,
  },
);

auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: AUDIT_RETENTION_SECONDS });
auditLogSchema.index({ event: 1, createdAt: -1 });
auditLogSchema.index({ actorUuid: 1, createdAt: -1 });
auditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });

export const IrcAuditLogModel: Model<IrcAuditLogDoc> =
  (mongoose.models['IrcAuditLog'] as Model<IrcAuditLogDoc> | undefined) ??
  mongoose.model<IrcAuditLogDoc>('IrcAuditLog', auditLogSchema);
