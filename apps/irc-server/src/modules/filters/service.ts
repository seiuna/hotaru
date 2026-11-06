import type { AppContext } from '../../context.js';
import { AppError } from '../../http/app-error.js';
import type { FilterRule, FilterScope, FilterService } from '../../runtime/contracts.js';
import { toCanonicalUuid } from '../groups/ids.js';
import {
  isDeniedByRules,
  normalizeFilterTarget,
  validateRuleInputs,
  type EvaluableRule,
} from './engine.js';
import { IrcFilterRuleModel, type IrcFilterRuleLean } from './model.js';

/**
 * How long a ruleset may be served from memory. Short on purpose: an edited
 * ruleset is applied immediately on the node that edited it, but other nodes
 * (and other processes sharing the database) converge within this window. Deny
 * rules are a safety control, so the staleness bound has to be small enough to
 * argue about: five seconds, not five minutes.
 */
const CACHE_TTL_MS = 5_000;
/** Bound on the per-process cache; scopes are per-user/per-group and can be many. */
const MAX_CACHE_ENTRIES = 10_000;

interface CacheEntry {
  rules: EvaluableRule[];
  expiresAt: number;
}

function toIso(value: Date | null | undefined): string {
  return value instanceof Date ? value.toISOString() : new Date(0).toISOString();
}

function toRule(doc: IrcFilterRuleLean): FilterRule {
  return {
    id: String(doc._id),
    scope: doc.scope,
    targetId: doc.targetId ?? null,
    pattern: doc.pattern,
    action: doc.action,
    enabled: doc.enabled !== false,
    createdAt: toIso(doc.createdAt),
  };
}

/**
 * Filter rules (design §11.4 / §12) backed by MongoDB with a short in-process
 * cache.
 *
 * The evaluator is deny-first (see `engine.ts`): a global deny applies to DIRECT,
 * GROUP and BROADCAST alike; group rules apply only to messages routed to that
 * group; user rules apply to every message that player receives.
 *
 * Cache correctness rules:
 * - every `replaceRules` on this process invalidates its own entry immediately;
 * - entries expire after `CACHE_TTL_MS`, which bounds how stale another writer's
 *   change can be;
 * - only `enabled` rules are cached, so a disabled rule never denies anything.
 */
export function createFilterService(ctx: AppContext): FilterService {
  const cache = new Map<string, CacheEntry>();

  function cacheKey(scope: FilterScope, targetId: string | null): string {
    return scope === 'GLOBAL' ? 'GLOBAL' : `${scope}:${targetId ?? ''}`;
  }

  function requireTarget(scope: FilterScope, targetId: string | null): string | null {
    const normalized = normalizeFilterTarget(scope, targetId);
    if (!normalized.ok) throw new AppError('INVALID_REQUEST', normalized.reason);
    return normalized.targetId;
  }

  async function loadActiveRules(
    scope: FilterScope,
    targetId: string | null,
  ): Promise<EvaluableRule[]> {
    const key = cacheKey(scope, targetId);
    const now = ctx.now();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) return cached.rules;

    const docs = await IrcFilterRuleModel.find({ scope, targetId, enabled: true })
      .select('pattern action enabled')
      .lean<Array<Pick<IrcFilterRuleLean, 'pattern' | 'action' | 'enabled'>>>()
      .exec();

    const rules: EvaluableRule[] = docs.map((doc) => ({
      pattern: doc.pattern,
      action: doc.action,
      enabled: doc.enabled !== false,
    }));

    if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
    cache.set(key, { rules, expiresAt: now + CACHE_TTL_MS });
    return rules;
  }

  async function listRulesInternal(
    scope: FilterScope,
    targetId: string | null,
  ): Promise<FilterRule[]> {
    const target = requireTarget(scope, targetId);
    const docs = await IrcFilterRuleModel.find({ scope, targetId: target })
      .sort({ pattern: 1, action: 1 })
      .lean<IrcFilterRuleLean[]>()
      .exec();
    return docs.map(toRule);
  }

  return {
    async isGloballyDenied(type) {
      return isDeniedByRules(type, await loadActiveRules('GLOBAL', null));
    },

    async isGroupDenied(groupId, type) {
      const id = typeof groupId === 'string' ? groupId.trim() : '';
      if (id.length === 0) return false;
      return isDeniedByRules(type, await loadActiveRules('GROUP', id));
    },

    async isUserDenied(userUuid, type) {
      const uuid = typeof userUuid === 'string' ? toCanonicalUuid(userUuid) : '';
      if (uuid.length === 0) return false;
      return isDeniedByRules(type, await loadActiveRules('USER', uuid));
    },

    async listRules(scope, targetId) {
      return listRulesInternal(scope, targetId);
    },

    async replaceRules(scope, targetId, rules, actorUuid) {
      const target = requireTarget(scope, targetId);
      const validated = validateRuleInputs(rules);
      if (!validated.ok) throw new AppError('INVALID_REQUEST', validated.reason);

      const actor = typeof actorUuid === 'string' ? actorUuid.trim().slice(0, 128) : '';
      if (actor.length === 0) {
        throw new AppError('UNAUTHORIZED', 'rule changes require an authenticated actor');
      }

      const now = new Date(ctx.now());
      const patterns = validated.rules.map((rule) => rule.pattern);

      // Upsert-then-prune instead of delete-then-insert: the scope never has a
      // window with zero rules, so a crash mid-write cannot leave the system
      // fail-open, and re-applying the same set is a no-op (idempotent PUT).
      await IrcFilterRuleModel.deleteMany({
        scope,
        targetId: target,
        pattern: { $nin: patterns },
      }).exec();

      if (validated.rules.length > 0) {
        await IrcFilterRuleModel.bulkWrite(
          validated.rules.map((rule) => ({
            updateOne: {
              filter: { scope, targetId: target, pattern: rule.pattern },
              update: {
                $set: {
                  action: rule.action,
                  enabled: true,
                  createdBy: actor,
                  updatedAt: now,
                },
                $setOnInsert: { createdAt: now },
              },
              upsert: true,
            },
          })),
          // The service owns the timestamps (they come from `ctx.now()`), so don't
          // let the schema's automatic timestamps overwrite them.
          { timestamps: false },
        );
      }

      // Apply the new set on this node immediately rather than after the TTL.
      cache.delete(cacheKey(scope, target));

      return listRulesInternal(scope, target);
    },
  };
}
