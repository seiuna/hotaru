import { describe, expect, it } from 'vitest';
import { formatDateTime, formatDuration, formatRelative, initialOf, shortUuid } from './format';

describe('formatDuration', () => {
  it('renders hours and minutes for long lifetimes', () => {
    expect(formatDuration(900)).toBe('15 分 0 秒');
    expect(formatDuration(8100)).toBe('2 小时 15 分');
  });

  it('marks non-positive values as expired', () => {
    expect(formatDuration(0)).toBe('已过期');
    expect(formatDuration(-5)).toBe('已过期');
  });
});

describe('formatRelative', () => {
  it('describes the past and the near-present', () => {
    const now = Date.parse('2026-11-06T12:00:00.000Z');
    expect(formatRelative('2026-11-06T11:59:58.000Z', now)).toBe('刚刚');
    expect(formatRelative('2026-11-06T10:00:00.000Z', now)).toBe('2 小时前');
    expect(formatRelative('2026-11-06T14:00:00.000Z', now)).toBe('2 小时后');
  });

  it('degrades to a dash for empty or invalid input', () => {
    expect(formatRelative(null)).toBe('—');
    expect(formatRelative('nope')).toBe('—');
  });
});

describe('small formatting helpers', () => {
  it('formats a date consistently', () => {
    expect(formatDateTime('2026-11-06T12:05:00.000Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(formatDateTime(null)).toBe('—');
  });

  it('shortens UUIDs without losing the ends', () => {
    expect(shortUuid('4c1099df-e202-4e64-9ea2-9039be420143')).toBe('4c1099df…0143');
    expect(shortUuid('short')).toBe('short');
  });

  it('picks a safe avatar initial', () => {
    expect(initialOf('yuuiyi')).toBe('Y');
    expect(initialOf('   ')).toBe('?');
  });
});
