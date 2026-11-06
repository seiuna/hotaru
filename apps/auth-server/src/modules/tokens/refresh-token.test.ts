import { describe, expect, it } from 'vitest';
import {
  generateRefreshToken,
  hashRefreshToken,
  REFRESH_TOKEN_BYTES,
} from './refresh-token.js';

describe('refresh tokens', () => {
  it('creates 32 bytes of base64url entropy', () => {
    const { token } = generateRefreshToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBe(43);
    expect(Buffer.from(token, 'base64url').length).toBe(REFRESH_TOKEN_BYTES);
  });

  it('never repeats a token', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 500; i++) tokens.add(generateRefreshToken().token);
    expect(tokens.size).toBe(500);
  });

  it('stores only a SHA-256 hex digest, never the token', () => {
    const { token, tokenHash } = generateRefreshToken();

    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toBe(token);
    expect(hashRefreshToken(token)).toBe(tokenHash);
    expect(hashRefreshToken(token)).not.toBe(hashRefreshToken(`${token}x`));
  });

  it('hashes deterministically', () => {
    const token = 'fixed-token-value';
    expect(hashRefreshToken(token)).toBe(hashRefreshToken(token));
  });
});
