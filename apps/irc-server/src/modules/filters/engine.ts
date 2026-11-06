import { LIMITS, matchTypePattern, validatePattern, validateTypeName } from '@skymatrix/srp-protocol';
import type { FilterAction, FilterScope } from '../../runtime/contracts.js';
import { toCanonicalUuid } from '../groups/ids.js';

/**
 * The filter engine: pattern validation, deny-first evaluation and target
 * normalisation, all pure so the security-relevant behaviour is testable without
 * a database.
 *
 * ## Semantics
 *
 * A rule list is evaluated per scope (GLOBAL → GROUP → USER):
 *
 * 1. **Any matching DENY wins** — deny-first, both inside a scope and across
 *    scopes. A user-level `chat.*` ALLOW can never resurrect a globally denied
 *    type.
 * 2. A matching ALLOW means "not denied by this scope".
 * 3. A scope that contains *only* ALLOW rules behaves as an allow-list: anything
 *    that matches none of them is denied. That is what makes an ALLOW rule
 *    meaningful — e.g. a group that only accepts `chat.*`.
 *
 * Patterns are the protocol's trivial wildcards (`chat.message`, `chat.*`, `*`),
 * never regexes, so a malicious rule cannot burn CPU during fan-out.
 */

/** A rule as stored; `enabled: false` rules are kept but never evaluated. */
export interface EvaluableRule {
  pattern: string;
  action: FilterAction;
  enabled: boolean;
}

export interface FilterRuleInput {
  pattern: string;
  action: FilterAction;
}

export interface FilterLayers {
  global: readonly EvaluableRule[];
  group?: readonly EvaluableRule[];
  user?: readonly EvaluableRule[];
}

export interface DenyEvaluation {
  denied: boolean;
  /** The scope whose rule denied the type, or null when nothing matched. */
  layer: FilterScope | null;
}

/** Upper bounds so one tenant cannot turn the filter table into a scan. */
export const MAX_RULES_PER_SCOPE = 100;
export const MAX_FILTER_TARGET_LENGTH = 128;
export const MAX_FILTER_PATTERN_LENGTH = 128;

/**
 * Evaluate one scope's rules against a message type.
 * Returns true when the type is denied by this scope.
 */
export function isDeniedByRules(type: string, rules: readonly EvaluableRule[]): boolean {
  let hasAllowRule = false;
  let hasDenyMatch = false;
  let hasAllowMatch = false;

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.action === 'ALLOW') hasAllowRule = true;
    const matches = matchTypePattern(type, rule.pattern);
    if (!matches) continue;
    if (rule.action === 'DENY') hasDenyMatch = true;
    else hasAllowMatch = true;
  }

  if (hasDenyMatch) return true; // deny-first, regardless of any ALLOW
  if (hasAllowMatch) return false;
  return hasAllowRule; // allow-list mode: unmatched types are denied
}

/** Compose the three scopes in precedence order (global beats group beats user). */
export function evaluateDenyFirst(type: string, layers: FilterLayers): DenyEvaluation {
  if (isDeniedByRules(type, layers.global)) return { denied: true, layer: 'GLOBAL' };
  if (layers.group !== undefined && isDeniedByRules(type, layers.group)) {
    return { denied: true, layer: 'GROUP' };
  }
  if (layers.user !== undefined && isDeniedByRules(type, layers.user)) {
    return { denied: true, layer: 'USER' };
  }
  return { denied: false, layer: null };
}

export type TargetResult = { ok: true; targetId: string | null } | { ok: false; reason: string };

/**
 * Normalise `(scope, targetId)` and reject combinations the storage layering
 * cannot represent: GLOBAL rules have no target; GROUP/USER rules require one.
 */
export function normalizeFilterTarget(
  scope: FilterScope,
  targetId: string | null | undefined,
): TargetResult {
  if (scope !== 'GLOBAL' && scope !== 'GROUP' && scope !== 'USER') {
    return { ok: false, reason: 'scope must be GLOBAL, GROUP or USER' };
  }

  const raw = typeof targetId === 'string' ? targetId.trim() : '';

  if (scope === 'GLOBAL') {
    if (raw.length > 0) return { ok: false, reason: 'GLOBAL rules must not carry a targetId' };
    return { ok: true, targetId: null };
  }

  if (raw.length === 0) return { ok: false, reason: `${scope} rules require a targetId` };
  if (raw.length > MAX_FILTER_TARGET_LENGTH) return { ok: false, reason: 'targetId is too long' };

  if (scope === 'USER') {
    const uuid = toCanonicalUuid(raw);
    if (uuid.length === 0) return { ok: false, reason: 'USER rules require a user UUID' };
    return { ok: true, targetId: uuid };
  }

  // Group ids are opaque (and validated by the groups module); keep them verbatim.
  return { ok: true, targetId: raw };
}

export type RuleValidation =
  | { ok: true; rules: FilterRuleInput[] }
  | { ok: false; reason: string };

/**
 * Validate a full rule replacement *before* anything is written.
 *
 * Reserved namespaces (`protocol.*`, `srp.*`) are server-owned: a filter rule
 * that could match them would let a tenant suppress or allow control frames.
 */
export function validateRuleInputs(rules: readonly FilterRuleInput[]): RuleValidation {
  if (!Array.isArray(rules)) return { ok: false, reason: 'rules must be an array' };
  if (rules.length > MAX_RULES_PER_SCOPE) {
    return { ok: false, reason: `at most ${MAX_RULES_PER_SCOPE} rules are allowed per scope` };
  }

  const seen = new Set<string>();
  const normalized: FilterRuleInput[] = [];

  for (const [index, rule] of rules.entries()) {
    if (typeof rule !== 'object' || rule === null) {
      return { ok: false, reason: `rule ${index}: must be an object` };
    }

    const pattern = typeof rule.pattern === 'string' ? rule.pattern.trim() : '';
    if (pattern.length === 0) return { ok: false, reason: `rule ${index}: pattern is required` };
    if (pattern.length > MAX_FILTER_PATTERN_LENGTH) {
      return { ok: false, reason: `rule ${index}: pattern is too long` };
    }

    const patternCheck = validatePattern(pattern);
    if (!patternCheck.ok) return { ok: false, reason: `rule ${index}: ${patternCheck.reason}` };

    const reserved = LIMITS.reservedPrefixes.find((prefix) => pattern.startsWith(prefix));
    if (reserved) {
      return {
        ok: false,
        reason: `rule ${index}: patterns may not target the reserved namespace ${reserved}`,
      };
    }

    // A pattern that could never match a valid type is a management mistake, not
    // a filter: validate the literal part with the same rules the router applies
    // to an incoming type (this is what rejects "chat..message").
    if (pattern !== '*') {
      const literal = pattern.endsWith('.*') ? pattern.slice(0, -2) : pattern;
      const literalCheck = validateTypeName(literal);
      if (!literalCheck.ok) {
        return { ok: false, reason: `rule ${index}: ${literalCheck.reason}` };
      }
    }

    if (rule.action !== 'ALLOW' && rule.action !== 'DENY') {
      return { ok: false, reason: `rule ${index}: action must be ALLOW or DENY` };
    }

    // Two rules for the same pattern (even with different actions) are a
    // management mistake, not a precedence puzzle; reject instead of guessing.
    if (seen.has(pattern)) return { ok: false, reason: `rule ${index}: duplicate rule for ${pattern}` };
    seen.add(pattern);

    normalized.push({ pattern, action: rule.action });
  }

  return { ok: true, rules: normalized };
}

/** Is this UUID allowed to edit the global rules? Constant-time is unnecessary: the list is public config. */
export function isAdminUuid(adminUuids: readonly string[], minecraftUuid: string): boolean {
  const uuid = typeof minecraftUuid === 'string' ? toCanonicalUuid(minecraftUuid) : '';
  if (uuid.length === 0) return false;
  return adminUuids.some((candidate) => toCanonicalUuid(String(candidate)) === uuid);
}
