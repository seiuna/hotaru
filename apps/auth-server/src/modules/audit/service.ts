import type { AppContext } from '../../context.js';
import { AuditLogModel } from '../../infrastructure/mongo/models/index.js';

export type AuditActorType = 'user' | 'admin' | 'system';

export interface AuditEntry {
  event: string;
  actorId?: string | null;
  actorType?: AuditActorType;
  targetType?: string | null;
  targetId?: string | null;
  ip?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Writes a security-relevant event. Audit failures must never break the request
 * they describe, but they are logged loudly so a broken audit sink is visible.
 */
export async function recordAudit(ctx: AppContext, entry: AuditEntry): Promise<void> {
  try {
    await AuditLogModel.create({
      event: entry.event,
      actorId: entry.actorId ?? null,
      actorType: entry.actorType ?? 'system',
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      ip: entry.ip ?? null,
      metadata: entry.metadata ?? null,
    });
  } catch (error) {
    // ctx.redis is not used here on purpose: keep this dependency-free.
    console.error('[audit] failed to persist audit event', entry.event, error);
  }
}
