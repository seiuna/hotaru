import { describe, expect, it } from 'vitest';
import {
  MAX_RULES_PER_SCOPE,
  evaluateDenyFirst,
  isAdminUuid,
  isDeniedByRules,
  normalizeFilterTarget,
  validateRuleInputs,
  type EvaluableRule,
  type FilterLayers,
} from './engine.js';

const deny = (pattern: string): EvaluableRule => ({ pattern, action: 'DENY', enabled: true });
const allow = (pattern: string): EvaluableRule => ({ pattern, action: 'ALLOW', enabled: true });

/**
 * Pattern matching is delegated to `@skymatrix/srp-protocol`; these cases pin the
 * exact edges the filter engine relies on (namespace wildcard vs a type named like
 * the namespace, case sensitivity, no regex semantics).
 */
describe('wildcard matching edge cases', () => {
  it('a namespace wildcard matches everything below it', () => {
    expect(isDeniedByRules('chat.message', [deny('chat.*')])).toBe(true);
    expect(isDeniedByRules('chat.message.extra', [deny('chat.*')])).toBe(true);
    // Whether `chat.*` also matches the bare `chat` type is defined by
    // @skymatrix/srp-protocol's matcher, not by this engine; the engine only
    // consumes it. See packages/srp-protocol/src/index.ts.
  });

  it('a namespace wildcard does not match a longer first segment', () => {
    expect(isDeniedByRules('chatx.message', [deny('chat.*')])).toBe(false);
    expect(isDeniedByRules('chatting', [deny('chat.*')])).toBe(false);
  });

  it('an exact pattern matches only itself', () => {
    expect(isDeniedByRules('chat.message', [deny('chat.message')])).toBe(true);
    expect(isDeniedByRules('chat.messages', [deny('chat.message')])).toBe(false);
    expect(isDeniedByRules('chat', [deny('chat.message')])).toBe(false);
    expect(isDeniedByRules('chat.message.extra', [deny('chat.message')])).toBe(false);
  });

  it('"*" matches everything, including reserved-looking types', () => {
    for (const type of ['chat.message', 'system.ping', 'a', 'protocol.ready']) {
      expect(isDeniedByRules(type, [deny('*')])).toBe(true);
    }
  });

  it('patterns are case-sensitive (the protocol treats types as opaque strings)', () => {
    expect(isDeniedByRules('chat.message', [deny('Chat.*')])).toBe(false);
    expect(isDeniedByRules('Chat.message', [deny('chat.*')])).toBe(false);
  });

  it('a wildcard never behaves like a regex', () => {
    // "chat.*" must not be compiled as a regex that would match "chatsomething".
    expect(isDeniedByRules('chatsomething', [deny('chat.*')])).toBe(false);
    expect(isDeniedByRules('chatx.message', [deny('chat.*')])).toBe(false);
  });
});

describe('deny-first evaluation within one scope', () => {
  it('denies when a deny rule matches', () => {
    expect(isDeniedByRules('chat.message', [deny('chat.message')])).toBe(true);
  });

  it('allows when nothing matches and there is no allow-list', () => {
    expect(isDeniedByRules('chat.message', [])).toBe(false);
    expect(isDeniedByRules('chat.message', [deny('system.*')])).toBe(false);
  });

  it('a matching DENY wins over a matching ALLOW', () => {
    expect(isDeniedByRules('chat.message', [allow('*'), deny('chat.message')])).toBe(true);
    expect(isDeniedByRules('chat.message', [allow('chat.*'), deny('*')])).toBe(true);
  });

  it('a scope with only ALLOW rules is an allow-list', () => {
    const rules = [allow('chat.*')];
    expect(isDeniedByRules('chat.message', rules)).toBe(false);
    expect(isDeniedByRules('system.ping', rules)).toBe(true);
  });

  it('an ALLOW rule cannot escape a DENY in the same scope', () => {
    expect(isDeniedByRules('chat.alert', [deny('chat.alert'), allow('chat.*')])).toBe(true);
  });

  it('ignores disabled rules', () => {
    expect(isDeniedByRules('chat.message', [{ pattern: 'chat.*', action: 'DENY', enabled: false }])).toBe(
      false,
    );
    // A disabled ALLOW also stops turning the scope into an allow-list.
    expect(isDeniedByRules('system.ping', [{ pattern: 'chat.*', action: 'ALLOW', enabled: false }])).toBe(
      false,
    );
  });
});

describe('scope precedence: global beats group beats user', () => {
  const layers = (
    global: EvaluableRule[],
    group: EvaluableRule[] = [],
    user: EvaluableRule[] = [],
  ): FilterLayers => ({ global, group, user });

  it('reports the scope that denied', () => {
    expect(evaluateDenyFirst('chat.message', layers([deny('chat.*')]))).toEqual({
      denied: true,
      layer: 'GLOBAL',
    });
    expect(evaluateDenyFirst('chat.message', layers([], [deny('chat.*')]))).toEqual({
      denied: true,
      layer: 'GROUP',
    });
    expect(evaluateDenyFirst('chat.message', layers([], [], [deny('chat.*')]))).toEqual({
      denied: true,
      layer: 'USER',
    });
  });

  it('a global deny cannot be overridden by a group or user allow', () => {
    const result = evaluateDenyFirst(
      'chat.message',
      layers([deny('chat.*')], [allow('*')], [allow('*')]),
    );
    expect(result).toEqual({ denied: true, layer: 'GLOBAL' });
  });

  it('a group deny cannot be overridden by a user allow', () => {
    expect(evaluateDenyFirst('chat.message', layers([], [deny('chat.message')], [allow('chat.*')]))).toEqual(
      { denied: true, layer: 'GROUP' },
    );
  });

  it('a global allow-list still denies types the group/user scopes allow', () => {
    // Global ALLOW rules make GLOBAL an allow-list: "system.ping" is outside it.
    expect(evaluateDenyFirst('system.ping', layers([allow('chat.*')], [allow('*')], [allow('*')]))).toEqual(
      { denied: true, layer: 'GLOBAL' },
    );
  });

  it('is not denied when no scope matches and no allow-list is configured', () => {
    expect(evaluateDenyFirst('chat.message', layers([]))).toEqual({ denied: false, layer: null });
    expect(evaluateDenyFirst('chat.message', layers([allow('chat.*')], [], []))).toEqual({
      denied: false,
      layer: null,
    });
  });
});

describe('pattern validation for replaceRules', () => {
  it('accepts the documented pattern shapes', () => {
    for (const pattern of ['*', 'chat', 'chat.message', 'chat.*', 'a-b_c.d']) {
      expect(validateRuleInputs([{ pattern, action: 'DENY' }]).ok).toBe(true);
    }
  });

  it('trims surrounding whitespace before storing', () => {
    const result = validateRuleInputs([{ pattern: '  chat.message  ', action: 'DENY' }]);
    expect(result).toEqual({ ok: true, rules: [{ pattern: 'chat.message', action: 'DENY' }] });
  });

  it('rejects malformed wildcards and empty patterns', () => {
    for (const pattern of ['', 'chat*', '*chat', 'chat.**', 'chat message', 'chat..message']) {
      const result = validateRuleInputs([{ pattern, action: 'DENY' }]);
      expect(result.ok).toBe(false);
    }
  });

  it('rejects the reserved protocol namespaces', () => {
    for (const pattern of ['protocol.*', 'protocol.ready', 'srp.*', 'srp.error']) {
      const result = validateRuleInputs([{ pattern, action: 'DENY' }]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('reserved namespace');
    }
  });

  it('rejects unknown actions', () => {
    const result = validateRuleInputs([{ pattern: 'chat.*', action: 'BLOCK' as 'DENY' }]);
    expect(result.ok).toBe(false);
  });

  it('rejects duplicate patterns', () => {
    const result = validateRuleInputs([
      { pattern: 'chat.*', action: 'DENY' },
      { pattern: 'chat.*', action: 'ALLOW' },
    ]);
    expect(result.ok).toBe(false);
  });

  it('rejects oversized rule sets', () => {
    const rules = Array.from({ length: MAX_RULES_PER_SCOPE + 1 }, (_, index) => ({
      pattern: `chat.rule${index}`,
      action: 'DENY' as const,
    }));
    expect(validateRuleInputs(rules).ok).toBe(false);
    expect(validateRuleInputs(rules.slice(0, MAX_RULES_PER_SCOPE)).ok).toBe(true);
  });

  it('rejects patterns longer than the type limit', () => {
    const result = validateRuleInputs([{ pattern: 'a'.repeat(129), action: 'DENY' }]);
    expect(result.ok).toBe(false);
  });
});

describe('target normalisation', () => {
  it('GLOBAL rules must not carry a target', () => {
    expect(normalizeFilterTarget('GLOBAL', null)).toEqual({ ok: true, targetId: null });
    expect(normalizeFilterTarget('GLOBAL', undefined)).toEqual({ ok: true, targetId: null });
    expect(normalizeFilterTarget('GLOBAL', '   ')).toEqual({ ok: true, targetId: null });
    expect(normalizeFilterTarget('GLOBAL', 'grp_abcdefgh').ok).toBe(false);
  });

  it('GROUP and USER rules require a target', () => {
    expect(normalizeFilterTarget('GROUP', null).ok).toBe(false);
    expect(normalizeFilterTarget('GROUP', '  ').ok).toBe(false);
    expect(normalizeFilterTarget('USER', null).ok).toBe(false);
    expect(normalizeFilterTarget('GROUP', 'grp_abcdefgh')).toEqual({
      ok: true,
      targetId: 'grp_abcdefgh',
    });
  });

  it('canonicalises a USER target to dashed lowercase', () => {
    expect(normalizeFilterTarget('USER', '0123456789ABCDEF0123456789ABCDEF')).toEqual({
      ok: true,
      targetId: '01234567-89ab-cdef-0123-456789abcdef',
    });
  });

  it('rejects an unknown scope', () => {
    expect(normalizeFilterTarget('CHANNEL' as 'GLOBAL', 'x').ok).toBe(false);
  });
});

describe('administrator check', () => {
  const admin = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';

  it('matches case-insensitively', () => {
    expect(isAdminUuid([admin], 'aaaaaaaabbbbccccddddeeeeeeeeeeee')).toBe(true);
    expect(isAdminUuid([admin], 'aaaaaaaabbbbccccddddeeeeeeeeeeeee')).toBe(false);
  });

  it('is false for empty input or empty configuration', () => {
    expect(isAdminUuid([], admin)).toBe(false);
    expect(isAdminUuid([admin], '')).toBe(false);
  });
});
