import { describe, expect, it } from 'vitest';
import {
  buildChallenge,
  classifyConsume,
  parseChallenge,
  SERVER_ID_BYTES,
  VERIFY_TOKEN_BYTES,
  type ChallengeRecord,
} from './challenge-store.js';

const TTL_SECONDS = 60;
const NOW = 1_700_000_000_000;

const pendingRecord = (overrides: Partial<ChallengeRecord> = {}): ChallengeRecord => {
  const record = buildChallenge('HotaruPlayer', TTL_SECONDS, NOW);
  return { ...record, ...overrides };
};

describe('buildChallenge', () => {
  it('produces a unique PENDING challenge bound to the requested username', () => {
    const first = buildChallenge('HotaruPlayer', TTL_SECONDS, NOW);
    const second = buildChallenge('HotaruPlayer', TTL_SECONDS, NOW);

    expect(first.challengeId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(first.challengeId).not.toBe(second.challengeId);
    expect(first.serverId).not.toBe(second.serverId);
    expect(first.verifyToken).not.toBe(second.verifyToken);

    expect(first.username).toBe('HotaruPlayer');
    expect(first.status).toBe('PENDING');
    expect(first.expiresAt).toBe(NOW + TTL_SECONDS * 1000);
    expect(first.createdAt).toBe(new Date(NOW).toISOString());
  });

  it('uses a 16-byte base64url server id and a 4-byte base64 verify token', () => {
    const challenge = buildChallenge('HotaruPlayer', TTL_SECONDS, NOW);

    expect(challenge.serverId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Buffer.from(challenge.serverId, 'base64url').length).toBe(SERVER_ID_BYTES);

    expect(challenge.verifyToken).toMatch(/^[A-Za-z0-9+/]{6}==$/);
    expect(Buffer.from(challenge.verifyToken, 'base64').length).toBe(VERIFY_TOKEN_BYTES);
  });
});

describe('parseChallenge', () => {
  it('round-trips a stored challenge', () => {
    const challenge = pendingRecord();
    expect(parseChallenge(JSON.stringify(challenge))).toEqual(challenge);
  });

  it('rejects malformed payloads instead of trusting them', () => {
    const valid = pendingRecord();

    expect(parseChallenge('not-json')).toBeNull();
    expect(parseChallenge('null')).toBeNull();
    expect(parseChallenge(JSON.stringify({ ...valid, status: 'CONSUMED' }))).toBeNull();
    expect(parseChallenge(JSON.stringify({ ...valid, challengeId: '' }))).toBeNull();
    expect(parseChallenge(JSON.stringify({ ...valid, username: 42 }))).toBeNull();
    expect(parseChallenge(JSON.stringify({ ...valid, verifyToken: '' }))).toBeNull();
    expect(parseChallenge(JSON.stringify({ ...valid, expiresAt: 'soon' }))).toBeNull();
    expect(parseChallenge(JSON.stringify({ ...valid, expiresAt: Number.NaN }))).toBeNull();
  });
});

describe('classifyConsume (challenge state machine)', () => {
  it('PENDING + live payload -> pending (and hands back the parsed challenge)', () => {
    const challenge = pendingRecord();
    const result = classifyConsume(JSON.stringify(challenge), 'consumed', NOW + 1_000);

    expect(result.outcome).toBe('pending');
    if (result.outcome !== 'pending') throw new Error('unreachable');
    expect(result.challenge.challengeId).toBe(challenge.challengeId);
  });

  it('PENDING -> consumed: terminal marker returns CONSUMED for every later attempt', () => {
    const result = classifyConsume(null, 'consumed', NOW);
    expect(result).toEqual({ outcome: 'consumed' });
  });

  it('PENDING -> expired: marker with an outlived challenge reports EXPIRED', () => {
    expect(classifyConsume(null, 'issued', NOW)).toEqual({ outcome: 'expired' });
    expect(classifyConsume(null, 'expired', NOW)).toEqual({ outcome: 'expired' });
  });

  it('payload whose deadline passed is EXPIRED even if the key still exists', () => {
    const challenge = pendingRecord();
    const result = classifyConsume(JSON.stringify(challenge), 'consumed', challenge.expiresAt);
    expect(result).toEqual({ outcome: 'expired' });

    const justInside = classifyConsume(
      JSON.stringify(challenge),
      'consumed',
      challenge.expiresAt - 1,
    );
    expect(justInside.outcome).toBe('pending');
  });

  it('unknown ids (no payload, no marker) are NOT_FOUND', () => {
    expect(classifyConsume(null, null, NOW)).toEqual({ outcome: 'not-found' });
    expect(classifyConsume(null, 'bogus', NOW)).toEqual({ outcome: 'not-found' });
  });

  it('a consumed challenge can never become pending again', () => {
    const consumed = classifyConsume(null, 'consumed', NOW);
    expect(consumed.outcome).toBe('consumed');
    // Still consumed after the retention window: the marker keeps it terminal.
    expect(classifyConsume(null, 'consumed', NOW + 10 * 60 * 1000).outcome).toBe('consumed');
  });

  it('treats unparseable payloads as NOT_FOUND (fail closed)', () => {
    expect(classifyConsume('{broken', null, NOW)).toEqual({ outcome: 'not-found' });
  });
});
