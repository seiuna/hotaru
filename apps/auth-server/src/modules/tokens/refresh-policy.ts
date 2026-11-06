/**
 * Pure refresh-token policy. Kept free of Mongo/Redis so the security-relevant
 * decision table can be unit tested exhaustively and reviewed in one screen.
 */

export interface RefreshTokenState {
  usedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
}

export interface RefreshSessionState {
  revokedAt: Date | null;
  expiresAt: Date;
}

export type RefreshDecision = 'not-found' | 'session-revoked' | 'expired' | 'reuse' | 'rotate';

export type RefreshReason =
  | 'UNKNOWN_TOKEN'
  | 'UNKNOWN_SESSION'
  | 'SESSION_REVOKED'
  | 'SESSION_EXPIRED'
  | 'TOKEN_REVOKED'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_REUSED'
  | 'OK';

export interface RefreshEvaluation {
  decision: RefreshDecision;
  reason: RefreshReason;
}

/**
 * Decides what a presented refresh token means.
 *
 * Order matters:
 *  - a token or session that no longer exists is simply invalid (no state to act on);
 *  - a revoked session wins over everything: the whole session is dead;
 *  - an expired token is dead but is *not* evidence of theft (rotation already
 *    happened legitimately or the user was simply away);
 *  - a token that is still live but already consumed means two parties hold the
 *    same rotating credential -> treat the session as compromised.
 */
export function evaluateRefresh(input: {
  token: RefreshTokenState | null;
  session: RefreshSessionState | null;
  nowMs: number;
}): RefreshEvaluation {
  const { token, session, nowMs } = input;

  if (!token) return { decision: 'not-found', reason: 'UNKNOWN_TOKEN' };
  if (!session) return { decision: 'not-found', reason: 'UNKNOWN_SESSION' };

  if (session.revokedAt) return { decision: 'session-revoked', reason: 'SESSION_REVOKED' };
  if (session.expiresAt.getTime() <= nowMs) {
    return { decision: 'session-revoked', reason: 'SESSION_EXPIRED' };
  }

  if (token.revokedAt) return { decision: 'session-revoked', reason: 'TOKEN_REVOKED' };
  if (token.expiresAt.getTime() <= nowMs) return { decision: 'expired', reason: 'TOKEN_EXPIRED' };
  if (token.usedAt) return { decision: 'reuse', reason: 'TOKEN_REUSED' };

  return { decision: 'rotate', reason: 'OK' };
}
