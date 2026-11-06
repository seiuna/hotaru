import { createHash, randomBytes } from 'node:crypto';

/** 256 bits of entropy — the token is the credential, so it must be unguessable. */
export const REFRESH_TOKEN_BYTES = 32;

export interface GeneratedRefreshToken {
  /** Opaque value handed to the client once. Never stored, never logged. */
  token: string;
  /** SHA-256 (hex) of the token — the only form that reaches the database. */
  tokenHash: string;
}

/** SHA-256 hex digest used as the database lookup key for an opaque refresh token. */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Creates a new opaque refresh token. base64url keeps it URL/header safe and
 * gives 43 characters for 32 bytes.
 */
export function generateRefreshToken(): GeneratedRefreshToken {
  const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashRefreshToken(token) };
}
