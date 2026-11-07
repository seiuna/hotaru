import { describe, expect, it } from 'vitest';
import type { PermissionView } from '@hotaru/shared-types';
import type { FastifyRequest } from 'fastify';
import {
  effectiveScopes,
  isExpired,
  isScope,
  toIso,
  toPermissionView,
  toUserView,
  currentAuth,
  EPOCH_ISO,
} from './service.js';

const NOW = new Date('2026-03-01T00:00:00.000Z');

function permission(overrides: Partial<PermissionView> = {}): PermissionView {
  return {
    scope: 'hotaru:profile',
    grantedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    grantedBy: null,
    ...overrides,
  };
}

describe('toUserView', () => {
  it('maps a lean user document to the wire view', () => {
    const view = toUserView({
      _id: '507f1f77bcf86cd799439011',
      minecraftUuid: '11111111-2222-3333-4444-555555555555',
      username: 'Notch',
      status: 'active',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      lastLoginAt: new Date('2026-02-01T00:00:00.000Z'),
    });

    expect(view).toEqual({
      id: '507f1f77bcf86cd799439011',
      minecraftUuid: '11111111-2222-3333-4444-555555555555',
      username: 'Notch',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: '2026-02-01T00:00:00.000Z',
    });
  });

  it('reports banned users and a null lastLoginAt', () => {
    const view = toUserView({
      _id: '507f1f77bcf86cd799439011',
      minecraftUuid: '11111111-2222-3333-4444-555555555555',
      username: 'Notch',
      status: 'banned',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      lastLoginAt: null,
    });

    expect(view.status).toBe('banned');
    expect(view.lastLoginAt).toBeNull();
  });
});

describe('toPermissionView', () => {
  it('maps a grant, including its expiry and granter', () => {
    const view = toPermissionView({
      scope: 'admin:users',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: new Date('2026-06-01T00:00:00.000Z'),
      grantedBy: '507f1f77bcf86cd799439012',
    });

    expect(view).toEqual({
      scope: 'admin:users',
      grantedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-06-01T00:00:00.000Z',
      grantedBy: '507f1f77bcf86cd799439012',
    });
  });

  it('drops scopes that are no longer part of the enum', () => {
    expect(toPermissionView({ scope: 'legacy:anything' })).toBeNull();
  });
});

describe('isExpired', () => {
  it('treats a null expiry as permanent', () => {
    expect(isExpired({ expiresAt: null }, NOW)).toBe(false);
  });

  it('compares the expiry against now (expiry exactly now counts as expired)', () => {
    expect(isExpired({ expiresAt: '2026-06-01T00:00:00.000Z' }, NOW)).toBe(false);
    expect(isExpired({ expiresAt: '2026-01-01T00:00:00.000Z' }, NOW)).toBe(true);
    expect(isExpired({ expiresAt: NOW.toISOString() }, NOW)).toBe(true);
  });

  it('treats an unparsable expiry as expired (fail closed)', () => {
    expect(isExpired({ expiresAt: 'not-a-date' }, NOW)).toBe(true);
  });
});

describe('effectiveScopes', () => {
  it('returns only unexpired grants', () => {
    const scopes = effectiveScopes(
      [
        permission({ scope: 'hotaru:profile' }),
        permission({ scope: 'hotaru:license', expiresAt: '2027-01-01T00:00:00.000Z' }),
        permission({ scope: 'admin:users', expiresAt: '2026-01-01T00:00:00.000Z' }),
      ],
      NOW,
    );

    expect(scopes).toEqual(['hotaru:profile', 'hotaru:license']);
  });

  it('is empty when every grant has expired', () => {
    expect(
      effectiveScopes([permission({ expiresAt: '2025-01-01T00:00:00.000Z' })], NOW),
    ).toEqual([]);
  });
});

describe('isScope', () => {
  it('accepts every enum member and rejects anything else', () => {
    expect(isScope('admin:users')).toBe(true);
    expect(isScope('hotaru:profile')).toBe(true);
    expect(isScope('admin:everything')).toBe(false);
  });
});

describe('toIso', () => {
  it('normalises dates and returns null for absent values', () => {
    expect(toIso(new Date('2026-01-01T00:00:00.000Z'))).toBe('2026-01-01T00:00:00.000Z');
    expect(toIso('2026-01-01T00:00:00.000Z')).toBe('2026-01-01T00:00:00.000Z');
    expect(toIso(null)).toBeNull();
    expect(toIso(undefined)).toBeNull();
    expect(toIso('nope')).toBeNull();
  });
});

describe('currentAuth', () => {
  it('fails closed when a handler runs without the auth guard', () => {
    expect(() => currentAuth({} as FastifyRequest)).toThrowError(
      expect.objectContaining({ code: 'UNAUTHORIZED' }),
    );
  });

  it('returns the authenticated context set by the guard', () => {
    const auth = {
      userId: '507f1f77bcf86cd799439011',
      minecraftUuid: '11111111-2222-3333-4444-555555555555',
      username: 'Notch',
      sessionId: '507f1f77bcf86cd799439021',
      jti: 'jti-1',
      scopes: ['hotaru:profile'] as const,
    };
    const request = { auth } as unknown as FastifyRequest;

    expect(currentAuth(request)).toBe(request.auth);
  });
});

describe('EPOCH_ISO', () => {
  it('is a valid ISO timestamp used as the deterministic fallback', () => {
    expect(EPOCH_ISO).toBe('1970-01-01T00:00:00.000Z');
  });
});
