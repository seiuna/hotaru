import { describe, expect, it } from 'vitest';
import { canonicalUuidOrNull, isGroupId, newGroupId, toCanonicalUuid } from './ids.js';

/**
 * Identity canonicalisation is what makes "the member I invited" and "the player
 * who connected" the same row. Mojang hands out undashed UUIDs, the auth server
 * stores and signs dashed lowercase, and clients send either; all three must land
 * on one representation or group fan-out silently misses recipients.
 */

const DASHED = '01234567-89ab-cdef-0123-456789abcdef';
const UNDASHED = '0123456789abcdef0123456789abcdef';
const UPPERCASE = '01234567-89AB-CDEF-0123-456789ABCDEF';

describe('canonicalUuidOrNull', () => {
  it('canonicalises dashed, undashed and uppercase forms to dashed lowercase', () => {
    expect(canonicalUuidOrNull(DASHED)).toBe(DASHED);
    expect(canonicalUuidOrNull(UNDASHED)).toBe(DASHED);
    expect(canonicalUuidOrNull(UPPERCASE)).toBe(DASHED);
    expect(canonicalUuidOrNull(`  ${UPPERCASE}  `)).toBe(DASHED);
  });

  it('rejects anything that is not a UUID', () => {
    expect(canonicalUuidOrNull('')).toBeNull();
    expect(canonicalUuidOrNull('not-a-uuid')).toBeNull();
    expect(canonicalUuidOrNull('01234567-89ab-cdef-0123')).toBeNull();
    expect(canonicalUuidOrNull('0123456789abcdef0123456789abcde')).toBeNull();
    expect(canonicalUuidOrNull('0123456789abcdef0123456789abcdef00')).toBeNull();
    expect(canonicalUuidOrNull('0123456789abcdef0123456789abcdeg')).toBeNull();
  });
});

describe('toCanonicalUuid', () => {
  it('canonicalises UUIDs', () => {
    expect(toCanonicalUuid(UNDASHED)).toBe(DASHED);
    expect(toCanonicalUuid(UPPERCASE)).toBe(DASHED);
  });

  it('keeps non-UUID identities (trusted JWT claims) instead of rejecting them', () => {
    expect(toCanonicalUuid('OfflinePlayer')).toBe('offlineplayer');
    expect(toCanonicalUuid('  test_user-1 ')).toBe('test_user-1');
  });
});

describe('group ids', () => {
  it('are prefixed, URL-safe and opaque (never an ObjectId)', () => {
    const id = newGroupId();
    expect(id.startsWith('grp_')).toBe(true);
    expect(isGroupId(id)).toBe(true);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(id).not.toMatch(/^[0-9a-f]{24}$/);
  });

  it('are unique', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newGroupId()));
    expect(ids.size).toBe(200);
  });

  it('reject malformed ids', () => {
    expect(isGroupId('')).toBe(false);
    expect(isGroupId('grp_')).toBe(false);
    expect(isGroupId('grp_short')).toBe(false);
    expect(isGroupId('grp_abcdefgh')).toBe(true);
    expect(isGroupId('group_abcdefgh')).toBe(false);
    expect(isGroupId('507f1f77bcf86cd799439011')).toBe(false);
  });
});
