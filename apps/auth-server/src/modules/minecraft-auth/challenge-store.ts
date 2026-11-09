import { randomBytes, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { Errors } from '../../errors.js';

/** One pending challenge: `auth:challenge:{id}` (contract key, TTL = challenge TTL). */
export const CHALLENGE_KEY_PREFIX = 'auth:challenge:';
/**
 * Terminal-state marker: `auth:challenge:state:{id}`. It outlives the challenge
 * so a late request can be told "consumed"/"expired" instead of "unknown".
 */
export const CHALLENGE_STATE_KEY_PREFIX = 'auth:challenge:state:';

/** How long the terminal-state marker is kept after the challenge itself dies. */
export const CHALLENGE_STATE_RETENTION_SECONDS = 600;

export const SERVER_ID_BYTES = 16;
export const VERIFY_TOKEN_BYTES = 4;

export interface ChallengeRecord {
  challengeId: string;
  /** Username the challenge was issued to, exactly as requested (display only). */
  username: string;
  /** Client identity and registered key fingerprint (null for legacy clients). */
  clientId: string;
  clientVersion: string | null;
  clientKeyId: string | null;
  /** Random salt for the Mojang server hash; never reused across challenges. */
  serverId: string;
  /** base64 of 4 raw random bytes the client must RSA-encrypt back. */
  verifyToken: string;
  status: 'PENDING';
  createdAt: string;
  /** Epoch milliseconds. Also mirrored by the Redis TTL. */
  expiresAt: number;
}

export type ChallengeStateMarker = 'issued' | 'consumed' | 'expired';

export type ConsumeOutcome =
  | { outcome: 'pending'; challenge: ChallengeRecord }
  | { outcome: 'consumed' }
  | { outcome: 'expired' }
  | { outcome: 'not-found' };

export function challengeKey(challengeId: string): string {
  return `${CHALLENGE_KEY_PREFIX}${challengeId}`;
}

export function challengeStateKey(challengeId: string): string {
  return `${CHALLENGE_STATE_KEY_PREFIX}${challengeId}`;
}

/**
 * GET the challenge and, in the same atomic step, delete it and stamp the
 * terminal state. Returns:
 *   1 + payload  -> a pending challenge was consumed (caller must still check expiry)
 *   2            -> already consumed
 *   3            -> issued but gone (expired by TTL)
 *   0            -> never existed
 */
const CONSUME_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if raw then
  redis.call('DEL', KEYS[1])
  redis.call('SET', KEYS[2], 'consumed', 'EX', tonumber(ARGV[1]))
  return {1, raw}
end
local state = redis.call('GET', KEYS[2])
if state == 'consumed' then
  return {2, ''}
end
if state == 'issued' or state == 'expired' then
  return {3, ''}
end
return {0, ''}
`;

export function buildChallenge(
  username: string,
  client: { id: string; version: string | null; keyId: string | null },
  ttlSeconds: number,
  nowMs: number = Date.now(),
): ChallengeRecord {
  return {
    challengeId: randomUUID(),
    username,
    clientId: client.id,
    clientVersion: client.version,
    clientKeyId: client.keyId,
    serverId: randomBytes(SERVER_ID_BYTES).toString('base64url'),
    verifyToken: randomBytes(VERIFY_TOKEN_BYTES).toString('base64'),
    status: 'PENDING',
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: nowMs + ttlSeconds * 1000,
  };
}

/** Rejects anything that is not a well-formed PENDING challenge. */
export function parseChallenge(raw: string): ChallengeRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;

  if (typeof candidate.challengeId !== 'string' || candidate.challengeId.length === 0) return null;
  if (typeof candidate.username !== 'string' || candidate.username.length === 0) return null;
  if (typeof candidate.clientId !== 'string' || candidate.clientId.length === 0) return null;
  if (candidate.clientVersion !== null && typeof candidate.clientVersion !== 'string') return null;
  if (candidate.clientKeyId !== null && typeof candidate.clientKeyId !== 'string') return null;
  if (typeof candidate.serverId !== 'string' || candidate.serverId.length === 0) return null;
  if (typeof candidate.verifyToken !== 'string' || candidate.verifyToken.length === 0) return null;
  if (typeof candidate.createdAt !== 'string') return null;
  if (typeof candidate.expiresAt !== 'number' || !Number.isFinite(candidate.expiresAt)) return null;
  if (candidate.status !== 'PENDING') return null;

  return {
    challengeId: candidate.challengeId,
    username: candidate.username,
    clientId: candidate.clientId,
    clientVersion: candidate.clientVersion ?? null,
    clientKeyId: candidate.clientKeyId ?? null,
    serverId: candidate.serverId,
    verifyToken: candidate.verifyToken,
    status: 'PENDING',
    createdAt: candidate.createdAt,
    expiresAt: candidate.expiresAt,
  };
}

/**
 * Pure state machine over the stored challenge plus its terminal marker. The
 * Lua script above decides *which* of those two is present; this function
 * decides what that means.
 */
export function classifyConsume(
  raw: string | null,
  state: ChallengeStateMarker | string | null,
  nowMs: number,
): ConsumeOutcome {
  if (raw !== null) {
    const challenge = parseChallenge(raw);
    if (!challenge) return { outcome: 'not-found' };
    if (challenge.expiresAt <= nowMs) return { outcome: 'expired' };
    return { outcome: 'pending', challenge };
  }

  if (state === 'consumed') return { outcome: 'consumed' };
  if (state === 'issued' || state === 'expired') return { outcome: 'expired' };
  return { outcome: 'not-found' };
}

export async function storeChallenge(
  redis: Redis,
  challenge: ChallengeRecord,
  ttlSeconds: number,
): Promise<void> {
  const ttl = Math.max(1, Math.ceil(ttlSeconds));
  await redis
    .multi()
    .set(challengeKey(challenge.challengeId), JSON.stringify(challenge), 'EX', ttl)
    .set(
      challengeStateKey(challenge.challengeId),
      'issued',
      'EX',
      ttl + CHALLENGE_STATE_RETENTION_SECONDS,
    )
    .exec();
}

interface EvalReply {
  code: number;
  raw: string | null;
}

function parseConsumeReply(reply: unknown): EvalReply {
  if (!Array.isArray(reply) || reply.length === 0) {
    throw Errors.internal(new Error('unexpected CHALLENGE_CONSUME reply'));
  }
  const [codeRaw, payloadRaw] = reply as unknown[];
  const code = typeof codeRaw === 'number' ? codeRaw : Number(codeRaw);
  if (!Number.isInteger(code)) {
    throw Errors.internal(new Error('unexpected CHALLENGE_CONSUME reply code'));
  }
  const raw = typeof payloadRaw === 'string' && payloadRaw.length > 0 ? payloadRaw : null;
  if (code === 1 && raw === null) {
    throw Errors.internal(new Error('CHALLENGE_CONSUME returned no payload'));
  }
  return { code, raw };
}

/**
 * Atomically consumes a challenge exactly once. Two concurrent verifies can
 * never both see a pending challenge: Redis executes the Lua script serially.
 */
export async function consumeChallenge(
  redis: Redis,
  challengeId: string,
  nowMs: number = Date.now(),
): Promise<ConsumeOutcome> {
  const reply = await redis.eval(
    CONSUME_SCRIPT,
    2,
    challengeKey(challengeId),
    challengeStateKey(challengeId),
    String(CHALLENGE_STATE_RETENTION_SECONDS),
  );
  const { code, raw } = parseConsumeReply(reply);

  if (code === 0) return { outcome: 'not-found' };
  const state: ChallengeStateMarker = code === 1 ? 'consumed' : code === 2 ? 'consumed' : 'issued';
  const outcome = classifyConsume(raw, state, nowMs);

  // Stored challenge outlived its deadline (clock skew / manual writes): make
  // the terminal marker say EXPIRED so later attempts are not told CONSUMED.
  if (outcome.outcome === 'expired' && raw !== null) {
    await redis.set(
      challengeStateKey(challengeId),
      'expired',
      'EX',
      CHALLENGE_STATE_RETENTION_SECONDS,
    );
  }

  return outcome;
}
