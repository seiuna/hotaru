import { IrcGroupMemberModel, IrcGroupModel } from '../../modules/groups/model.js';
import { IrcFilterRuleModel } from '../../modules/filters/model.js';
import { IrcAuditLogModel } from '../../modules/audit/model.js';

/**
 * Creates the declared indexes if they are missing.
 *
 * Mongoose's `autoIndex` is disabled in production, and the IRC schema depends on
 * unique constraints for correctness, not just speed: one membership row per
 * `(groupId, userUuid)`, one filter rule per `(scope, targetId, pattern, action)`.
 * `createIndexes()` is additive — it never drops an index an operator added by
 * hand — so running it on every boot is safe.
 */
export async function ensureIndexes(): Promise<void> {
  await IrcGroupModel.createIndexes();
  await IrcGroupMemberModel.createIndexes();
  await IrcFilterRuleModel.createIndexes();
  await IrcAuditLogModel.createIndexes();
}
