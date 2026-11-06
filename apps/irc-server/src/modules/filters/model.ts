import mongoose, { type Model } from 'mongoose';
import type { FilterAction, FilterScope } from '../../runtime/contracts.js';

/**
 * `irc_filter_rules` (design §11.4): one row per rule, keyed by
 * `(scope, targetId, pattern, action)`.
 *
 * `targetId` is `null` for GLOBAL, the group id for GROUP and the canonical user
 * UUID for USER. MongoDB treats `null` as an ordinary indexed value, so the
 * unique key still separates global rules from targeted ones.
 *
 * Rules are replaced as a set (`FilterService.replaceRules`), never edited
 * individually: the evaluator loads a whole scope at once, so a half-applied set
 * would be a security-relevant intermediate state.
 *
 * Note the default `mongoose` import: mongoose is CJS, and `models` is not one of
 * the statically detectable named exports, so `import { models } from 'mongoose'`
 * type-checks but throws at runtime in ESM.
 */
export interface IrcFilterRuleDoc {
  scope: FilterScope;
  targetId: string | null;
  pattern: string;
  action: FilterAction;
  enabled: boolean;
  /** Whoever last replaced the rule set (identifier, never content). */
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const filterRuleSchema = new mongoose.Schema<IrcFilterRuleDoc>(
  {
    scope: { type: String, enum: ['GLOBAL', 'GROUP', 'USER'], required: true },
    targetId: { type: String, default: null },
    pattern: { type: String, required: true },
    action: { type: String, enum: ['ALLOW', 'DENY'], required: true },
    enabled: { type: Boolean, default: true, required: true },
    createdBy: { type: String, default: null },
  },
  { timestamps: true, collection: 'irc_filter_rules', versionKey: false },
);

filterRuleSchema.index({ scope: 1, targetId: 1, pattern: 1, action: 1 }, { unique: true });
// Evaluation path: one scope/target, enabled rules only.
filterRuleSchema.index({ scope: 1, targetId: 1, enabled: 1 });

export const IrcFilterRuleModel: Model<IrcFilterRuleDoc> =
  (mongoose.models['IrcFilterRule'] as Model<IrcFilterRuleDoc> | undefined) ??
  mongoose.model<IrcFilterRuleDoc>('IrcFilterRule', filterRuleSchema);

/** Projection returned by read queries. */
export interface IrcFilterRuleLean {
  _id: unknown;
  scope: FilterScope;
  targetId: string | null;
  pattern: string;
  action: FilterAction;
  enabled: boolean;
  createdAt: Date;
}
