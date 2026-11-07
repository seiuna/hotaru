import { describe, expect, it } from 'vitest';
import { decodeToken, isTokenExpired } from './jwt';

/** Builds a structurally valid (but unsigned-for-real) JWT payload. */
function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${encode({ alg: 'EdDSA', typ: 'JWT' })}.${encode(payload)}.signature`;
}

describe('decodeToken', () => {
  it('reads the claims the UI needs', () => {
    const token = fakeJwt({
      sub: 'user-1',
      sid: 'session-1',
      minecraft_uuid: '4c1099df-e202-4e64-9ea2-9039be420143',
      scope: 'hotaru:profile admin:users',
      iss: 'https://auth.example.com',
      aud: ['hotaru-api'],
      iat: 1_700_000_000,
      exp: 1_700_000_900,
      jti: 'jti-1',
    });

    const decoded = decodeToken(token);
    expect(decoded).not.toBeNull();
    expect(decoded?.sub).toBe('user-1');
    expect(decoded?.sid).toBe('session-1');
    expect(decoded?.exp).toBe(1_700_000_900);
    expect(decoded?.scope).toContain('admin:users');
  });

  it('rejects malformed input instead of throwing', () => {
    expect(decodeToken('')).toBeNull();
    expect(decodeToken('not-a-jwt')).toBeNull();
    expect(decodeToken('a.b')).toBeNull();
    expect(decodeToken('a.%%%.c')).toBeNull();
  });

  it('requires an exp claim', () => {
    expect(decodeToken(fakeJwt({ sub: 'x' }))).toBeNull();
  });
});

describe('isTokenExpired', () => {
  const token = fakeJwt({ exp: 1_000 });

  it('is true past the expiry', () => {
    // now is in milliseconds: 1_000_001 s
    expect(isTokenExpired(token, 1_000_001_000)).toBe(true);
  });

  it('is false before the expiry', () => {
    // 999 s < 1000 s expiry
    expect(isTokenExpired(token, 999_000)).toBe(false);
  });

  it('treats unparseable tokens as expired', () => {
    expect(isTokenExpired('garbage')).toBe(true);
  });
});
