import { describe, expect, it } from 'vitest';
import { computeGrantDiff, isDiffEmpty, toIsoOrNull, toLocalInputValue } from './permissions';

describe('computeGrantDiff', () => {
  it('reports additions, removals and expiry changes', () => {
    const diff = computeGrantDiff(
      [
        { scope: 'skymatrix:profile', expiresAt: null },
        { scope: 'skymatrix:resource', expiresAt: '2027-01-01T00:00:00.000Z' },
      ],
      [
        { scope: 'skymatrix:profile', expiresAt: null },
        { scope: 'skymatrix:ircserver', expiresAt: null },
        { scope: 'skymatrix:resource', expiresAt: '2027-06-01T00:00:00.000Z' },
      ],
    );

    expect(diff.added).toEqual(['skymatrix:ircserver']);
    expect(diff.removed).toEqual([]);
    expect(diff.updated).toEqual(['skymatrix:resource']);
    expect(diff.unchanged).toEqual(['skymatrix:profile']);
    expect(isDiffEmpty(diff)).toBe(false);
  });

  it('detects revoking everything', () => {
    const diff = computeGrantDiff([{ scope: 'admin:users', expiresAt: null }], []);
    expect(diff.removed).toEqual(['admin:users']);
    expect(diff.added).toEqual([]);
  });

  it('is empty when nothing changed', () => {
    const current = [{ scope: 'skymatrix:profile' as const, expiresAt: null }];
    expect(isDiffEmpty(computeGrantDiff(current, [...current]))).toBe(true);
  });

  it('treats a null/undefined expiry difference as a change', () => {
    const diff = computeGrantDiff(
      [{ scope: 'skymatrix:resource', expiresAt: null }],
      [{ scope: 'skymatrix:resource', expiresAt: '2030-01-01T00:00:00.000Z' }],
    );
    expect(diff.updated).toEqual(['skymatrix:resource']);
  });
});

describe('time helpers', () => {
  it('round-trips an ISO timestamp through the datetime-local format', () => {
    const iso = '2027-03-04T05:06:00.000Z';
    const local = toLocalInputValue(iso);
    expect(local).not.toBeNull();
    const back = toIsoOrNull(local);
    expect(back).not.toBeNull();
    // Local rendering then re-parsing must land on the same instant.
    expect(new Date(back as string).getTime()).toBe(new Date(iso).getTime());
  });

  it('maps empty input to null (permanent grant)', () => {
    expect(toIsoOrNull('')).toBeNull();
    expect(toIsoOrNull(null)).toBeNull();
    expect(toIsoOrNull(undefined)).toBeNull();
    expect(toLocalInputValue(null)).toBeNull();
  });

  it('rejects nonsense timestamps', () => {
    expect(toIsoOrNull('not-a-date')).toBeNull();
  });
});
