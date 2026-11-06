import { describe, expect, it } from 'vitest';
import { evaluateRefresh, type RefreshSessionState, type RefreshTokenState } from './refresh-policy.js';

const NOW = 1_700_000_000_000;
const LATER = NOW + 60_000;
const EARLIER = NOW - 60_000;

const liveToken = (overrides: Partial<RefreshTokenState> = {}): RefreshTokenState => ({
  usedAt: null,
  revokedAt: null,
  expiresAt: new Date(LATER),
  ...overrides,
});

const liveSession = (overrides: Partial<RefreshSessionState> = {}): RefreshSessionState => ({
  revokedAt: null,
  expiresAt: new Date(LATER),
  ...overrides,
});

const evaluate = (
  token: RefreshTokenState | null,
  session: RefreshSessionState | null,
) => evaluateRefresh({ token, session, nowMs: NOW });

describe('evaluateRefresh', () => {
  it('rotates a fresh token in a live session', () => {
    expect(evaluate(liveToken(), liveSession())).toEqual({ decision: 'rotate', reason: 'OK' });
  });

  it('rejects unknown tokens and tokens whose session vanished', () => {
    expect(evaluate(null, liveSession())).toEqual({ decision: 'not-found', reason: 'UNKNOWN_TOKEN' });
    expect(evaluate(liveToken(), null)).toEqual({
      decision: 'not-found',
      reason: 'UNKNOWN_SESSION',
    });
  });

  it('detects reuse of an already-used token that is still live', () => {
    expect(evaluate(liveToken({ usedAt: new Date(EARLIER) }), liveSession())).toEqual({
      decision: 'reuse',
      reason: 'TOKEN_REUSED',
    });
  });

  it('treats an expired token as expired, not as reuse', () => {
    expect(evaluate(liveToken({ expiresAt: new Date(EARLIER) }), liveSession())).toEqual({
      decision: 'expired',
      reason: 'TOKEN_EXPIRED',
    });
  });

  it('expires exactly at the deadline', () => {
    const token = liveToken({ expiresAt: new Date(NOW) });
    expect(evaluate(token, liveSession()).decision).toBe('expired');
  });

  it('lets a revoked session win over any token state', () => {
    expect(evaluate(liveToken(), liveSession({ revokedAt: new Date(EARLIER) }))).toEqual({
      decision: 'session-revoked',
      reason: 'SESSION_REVOKED',
    });
    expect(
      evaluate(liveToken({ usedAt: new Date(EARLIER) }), liveSession({ revokedAt: new Date(EARLIER) }))
        .decision,
    ).toBe('session-revoked');
  });

  it('treats an expired session as revoked', () => {
    expect(evaluate(liveToken(), liveSession({ expiresAt: new Date(EARLIER) }))).toEqual({
      decision: 'session-revoked',
      reason: 'SESSION_EXPIRED',
    });
  });

  it('treats an individually revoked refresh token as a dead session', () => {
    expect(evaluate(liveToken({ revokedAt: new Date(EARLIER) }), liveSession())).toEqual({
      decision: 'session-revoked',
      reason: 'TOKEN_REVOKED',
    });
  });

  it('does not flag reuse after the session was revoked (revocation is the stronger signal)', () => {
    const decision = evaluate(
      liveToken({ usedAt: new Date(EARLIER), revokedAt: new Date(EARLIER) }),
      liveSession({ revokedAt: new Date(EARLIER) }),
    );
    expect(decision.decision).toBe('session-revoked');
    expect(decision.reason).toBe('SESSION_REVOKED');
  });

  it('does not flag reuse for a token that expired before being replayed', () => {
    const decision = evaluate(liveToken({ usedAt: new Date(EARLIER), expiresAt: new Date(EARLIER) }), liveSession());
    expect(decision.decision).toBe('expired');
  });
});
