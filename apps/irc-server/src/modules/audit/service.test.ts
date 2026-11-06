import { describe, expect, it } from 'vitest';
import { normalizeIdentifier, sanitizeMetadata } from './service.js';

/**
 * Audit records must never become a content archive. These tests pin the
 * structural guarantee: identifiers survive, message-like keys and oversized
 * values do not.
 */
describe('sanitizeMetadata', () => {
  it('keeps decision metadata', () => {
    expect(
      sanitizeMetadata({ scope: 'GROUP', ruleCount: 3, memberUuid: 'abc', role: 'ADMIN' }),
    ).toEqual({ scope: 'GROUP', ruleCount: 3, memberUuid: 'abc', role: 'ADMIN' });
  });

  it('drops keys that would carry a payload or a credential', () => {
    const result = sanitizeMetadata({
      messageId: 'ok-id',
      payload: { text: 'hello world' },
      message: 'hello',
      content: 'hello',
      body: 'hello',
      text: 'hello',
      token: 'secret',
      accessToken: 'secret',
      refreshToken: 'secret',
      authorization: 'Bearer x',
      password: 'hunter2',
      jwt: 'aaa.bbb.ccc',
      chat: 'hello',
    });

    expect(result).toEqual({ messageId: 'ok-id' });
  });

  it('rejects an object whose every key is forbidden', () => {
    expect(sanitizeMetadata({ payload: 'x', content: 'y' })).toBeNull();
  });

  it('returns null for empty, null or non-object input', () => {
    expect(sanitizeMetadata(null)).toBeNull();
    expect(sanitizeMetadata(undefined)).toBeNull();
    expect(sanitizeMetadata({})).toBeNull();
    expect(sanitizeMetadata([1, 2] as unknown as Record<string, unknown>)).toBeNull();
  });

  it('truncates long strings instead of storing them', () => {
    const result = sanitizeMetadata({ note: 'a'.repeat(500) });
    expect(typeof result?.['note']).toBe('string');
    expect((result?.['note'] as string).length).toBeLessThan(500);
  });

  it('bounds arrays and nested objects', () => {
    const result = sanitizeMetadata({
      list: Array.from({ length: 100 }, (_, index) => index),
      nested: { deeper: { deepest: { value: 'x' } }, payload: 'drop me' },
    });

    expect((result?.['list'] as number[]).length).toBe(20);
    expect(result?.['nested']).toEqual({ deeper: { deepest: null } });
  });

  it('drops non-finite numbers and unsupported values', () => {
    const result = sanitizeMetadata({
      nan: Number.NaN,
      infinite: Number.POSITIVE_INFINITY,
      fn: () => undefined,
      big: 10n,
      keep: true,
    });
    expect(result).toEqual({ nan: null, infinite: null, keep: true });
  });
});

describe('normalizeIdentifier', () => {
  it('trims, caps and nulls empty identifiers', () => {
    expect(normalizeIdentifier('  abc  ')).toBe('abc');
    expect(normalizeIdentifier('')).toBeNull();
    expect(normalizeIdentifier('   ')).toBeNull();
    expect(normalizeIdentifier(null)).toBeNull();
    expect(normalizeIdentifier(undefined)).toBeNull();
    expect(normalizeIdentifier('x'.repeat(500))?.length).toBe(200);
  });
});
