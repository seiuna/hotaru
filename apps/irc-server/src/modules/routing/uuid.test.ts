import { describe, expect, it } from 'vitest';
import { normalizeUuid } from './index.js';

describe('normalizeUuid', () => {
  it('accepts dashed UUIDs and lower-cases them', () => {
    expect(normalizeUuid('4C1099DF-E202-4E64-9EA2-9039BE420143')).toBe(
      '4c1099df-e202-4e64-9ea2-9039be420143',
    );
  });

  it('accepts the undashed form Mojang uses', () => {
    expect(normalizeUuid('4c1099dfe2024e649ea29039be420143')).toBe(
      '4c1099df-e202-4e64-9ea2-9039be420143',
    );
  });

  it('rejects anything that is not a UUID', () => {
    expect(normalizeUuid('')).toBeNull();
    expect(normalizeUuid('not-a-uuid')).toBeNull();
    expect(normalizeUuid('4c1099df-e202-4e64-9ea2')).toBeNull();
    expect(normalizeUuid('4c1099dfe202-4e64-9ea2-9039be420143-extra')).toBeNull();
  });
});
