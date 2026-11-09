import { describe, expect, it } from 'vitest';
import { profileTags } from '@hotaru/srp-protocol';
import { normalizeManualTags, validateNickname } from './service.js';

describe('profileTags', () => {
  it('derives admin over user and merges manual tags', () => {
    expect(profileTags(['admin:users', 'hotaru:ircserver'], ['dev', 'vip'])).toEqual([
      'admin',
      'dev',
      'vip',
    ]);
  });

  it('keeps the normal user tag for non-admin tokens', () => {
    expect(profileTags(['hotaru:ircserver'], ['tester'])).toEqual(['tester', 'user']);
  });

  it('never accepts reserved tags from the manual list', () => {
    expect(profileTags(['hotaru:ircserver'], ['admin', 'user', 'dev'])).toEqual(['dev', 'user']);
  });
});

describe('nickname validation', () => {
  it('accepts a normal nickname', () => {
    expect(validateNickname('Suki')).toBe('Suki');
    expect(validateNickname('小月月')).toBe('小月月');
  });

  it('rejects spaces, reserved names and all-digit names', () => {
    expect(() => validateNickname('bad name')).toThrow();
    expect(() => validateNickname('admin')).toThrow();
    expect(() => validateNickname('12345')).toThrow();
    expect(() => validateNickname('ab')).toThrow();
  });
});

describe('manual tags', () => {
  it('accepts only known non-reserved tags', () => {
    expect(normalizeManualTags(['vip', 'dev'])).toEqual(['dev', 'vip']);
    expect(() => normalizeManualTags(['admin'])).toThrow();
    expect(() => normalizeManualTags(['unknown'])).toThrow();
    expect(() => normalizeManualTags(['dev', 'vip', 'tester', 'user'])).toThrow();
  });
});
