import type { ChallengeResponse, TokenResponse, VerifyRequest } from '@hotaru/api-contract';
import type { AppContext } from '../../context.js';
import { AppError, Errors } from '../../errors.js';
import {
  MinecraftLinkModel,
  UserModel,
} from '../../infrastructure/mongo/models/index.js';
import { minecraftServerHash } from '../../infrastructure/crypto/server-hash.js';
import { hasJoined, type HasJoinedInput } from '../../infrastructure/mojang/client.js';
import { recordAudit } from '../audit/service.js';
import { startSession } from '../tokens/service.js';
import { effectiveScopes } from '../tokens/scopes.js';
import {
  buildChallenge,
  consumeChallenge,
  storeChallenge,
  type ConsumeOutcome,
} from './challenge-store.js';
import { decodeBase64, decryptRsaPkcs1, safeEqual } from './crypto.js';
import { consumeRateLimit, rateLimitIpKey, rateLimitUsernameKey } from './rate-limit.js';
import { issueBindingCode } from './binding-code.js';
import {
  assertAccountNotBanned,
  findLinkedAccount,
} from './user-repository.js';

/** The vanilla handshake always carries a 16-byte AES key. */
export const SHARED_SECRET_BYTES = 16;

export interface AuthRequestMeta {
  ip: string | null;
  userAgent: string | null;
}

const normalizeUsername = (username: string): string => username.toLowerCase();

/** Minecraft names are case-insensitive for matching but case-preserving for display. */
export function sameUsername(a: string, b: string): boolean {
  return normalizeUsername(a) === normalizeUsername(b);
}

async function recordChallengeRejected(
  ctx: AppContext,
  meta: AuthRequestMeta,
  details: { username: string; challengeId?: string; reason: string },
): Promise<void> {
  await recordAudit(ctx, {
    event: 'auth.challenge.rejected',
    actorType: 'system',
    targetType: 'challenge',
    targetId: details.challengeId ?? null,
    ip: meta.ip,
    metadata: { username: details.username, reason: details.reason },
  });
}

async function enforceRateLimits(
  ctx: AppContext,
  keys: string[],
  max: number,
): Promise<void> {
  const windowSeconds = ctx.config.rateLimitWindowSeconds;
  const results = await Promise.all(
    keys.map((key) => consumeRateLimit(ctx.redis, key, max, windowSeconds)),
  );
  const blocked = results.find((result) => !result.allowed);
  if (blocked) throw Errors.rateLimited(blocked.retryAfterSeconds);
}

/**
 * Issues a single-use challenge. The RSA key pair is service-wide and stable
 * (never generated per request), so the client can cache the public key.
 */
export async function createChallenge(
  ctx: AppContext,
  input: { username: string; ip: string | null },
): Promise<ChallengeResponse> {
  const meta: AuthRequestMeta = { ip: input.ip, userAgent: null };

  try {
    const keys = [rateLimitUsernameKey(input.username)];
    if (input.ip) keys.push(rateLimitIpKey(input.ip));
    await enforceRateLimits(ctx, keys, ctx.config.rateLimitChallengeMax);
  } catch (error) {
    if (error instanceof AppError && error.code === 'RATE_LIMITED') {
      await recordChallengeRejected(ctx, meta, {
        username: input.username,
        reason: 'rate_limited',
      });
    }
    throw error;
  }

  const challenge = buildChallenge(input.username, ctx.config.challengeTtlSeconds);
  await storeChallenge(ctx.redis, challenge, ctx.config.challengeTtlSeconds);

  await recordAudit(ctx, {
    event: 'auth.challenge.created',
    actorType: 'system',
    targetType: 'challenge',
    targetId: challenge.challengeId,
    ip: input.ip,
    metadata: { username: challenge.username },
  });

  return {
    challengeId: challenge.challengeId,
    serverId: challenge.serverId,
    publicKey: ctx.keys.minecraft.publicKeyBase64,
    verifyToken: challenge.verifyToken,
    expiresIn: ctx.config.challengeTtlSeconds,
  };
}

/**
 * Verifies a challenge and, only if Mojang confirms the premium session, issues
 * a session + token pair. Every failure path is fail-closed: no token is ever
 * issued without a positive `hasJoined` answer for the challenge's serverId.
 */
export async function verifyChallenge(
  ctx: AppContext,
  input: VerifyRequest,
  meta: AuthRequestMeta,
): Promise<TokenResponse> {
  try {
    const rateKeys = [rateLimitUsernameKey(input.username)];
    if (meta.ip) rateKeys.push(rateLimitIpKey(meta.ip));
    await enforceRateLimits(ctx, rateKeys, ctx.config.rateLimitVerifyMax);
  } catch (error) {
    if (error instanceof AppError && error.code === 'RATE_LIMITED') {
      await recordChallengeRejected(ctx, meta, {
        username: input.username,
        challengeId: input.challengeId,
        reason: 'rate_limited',
      });
    }
    throw error;
  }

  const consumed: ConsumeOutcome = await consumeChallenge(ctx.redis, input.challengeId);
  if (consumed.outcome === 'not-found') throw Errors.challengeNotFound();
  if (consumed.outcome === 'consumed') throw Errors.challengeConsumed();
  if (consumed.outcome === 'expired') throw Errors.challengeExpired();

  const challenge = consumed.challenge;

  // The challenge is bound to the username it was issued for: a challenge can
  // never be redeemed as a different player, even case-insensitively renamed.
  if (!sameUsername(challenge.username, input.username)) {
    await recordChallengeRejected(ctx, meta, {
      username: input.username,
      challengeId: challenge.challengeId,
      reason: 'username_mismatch',
    });
    throw Errors.invalidRequest('Challenge was issued for a different username');
  }

  const encryptedSharedSecret = decodeBase64(input.encryptedSharedSecret);
  const encryptedVerifyToken = decodeBase64(input.encryptedVerifyToken);

  // Both decrypt failures collapse into the same INVALID_REQUEST (see crypto.ts).
  const sharedSecret = decryptRsaPkcs1(ctx.keys.minecraft.privateKey, encryptedSharedSecret);
  const verifyToken = decryptRsaPkcs1(ctx.keys.minecraft.privateKey, encryptedVerifyToken);

  // Wire format: verifyToken is base64 of 4 raw bytes; the client encrypts the
  // decoded bytes, so compare decrypted bytes against the decoded default.
  // Node's RSA/PKCS#1 decryption uses implicit rejection, so a garbage decrypt
  // surfaces here rather than at decrypt time; the message is shared with the
  // shared-secret length failure on purpose (no field-level oracle).
  const expectedVerifyToken = Buffer.from(challenge.verifyToken, 'base64');
  const sharedSecretLengthValid = sharedSecret.length === SHARED_SECRET_BYTES;
  if (!safeEqual(verifyToken, expectedVerifyToken) || !sharedSecretLengthValid) {
    await recordChallengeRejected(ctx, meta, {
      username: input.username,
      challengeId: challenge.challengeId,
      reason: safeEqual(verifyToken, expectedVerifyToken)
        ? 'invalid_shared_secret'
        : 'verify_token_mismatch',
    });
    throw Errors.invalidRequest('Encrypted handshake payload is invalid');
  }

  const serverId = minecraftServerHash(
    challenge.serverId,
    sharedSecret,
    ctx.keys.minecraft.publicKeyDer,
  );

  const joinInput: HasJoinedInput = { username: challenge.username, serverId };
  if (meta.ip) joinInput.ip = meta.ip;

  let profile: { uuid: string; username: string } | null;
  try {
    profile = await hasJoined(ctx.config, joinInput);
  } catch (error) {
    if (error instanceof AppError && error.code === 'MOJANG_UNAVAILABLE') {
      await recordChallengeRejected(ctx, meta, {
        username: input.username,
        challengeId: challenge.challengeId,
        reason: 'mojang_unavailable',
      });
    }
    throw error;
  }

  if (!profile) {
    await recordChallengeRejected(ctx, meta, {
      username: input.username,
      challengeId: challenge.challengeId,
      reason: 'not_premium_session',
    });
    throw Errors.notPremiumSession();
  }

  // Identity comes from Mojang only: `profile.uuid`/`profile.username` were
  // derived from hasJoined, never from the request body.
  const linked = await findLinkedAccount(profile.uuid);
  if (!linked) {
    const binding = await issueBindingCode(ctx, profile);
    await recordAudit(ctx, {
      event: 'auth.link.required',
      actorType: 'system',
      targetType: 'minecraft_identity',
      targetId: profile.uuid,
      ip: meta.ip,
      metadata: { username: profile.username },
    });
    throw Errors.linkRequired({
      bindingCode: binding.code,
      expiresIn: binding.expiresIn,
    });
  }

  if (linked.link.status === 'banned') {
    throw Errors.uuidBanned();
  }

  const user = linked.user;
  await assertAccountNotBanned(ctx, user, meta.ip);

  const username = profile.username;
  const now = new Date();
  await Promise.all([
    UserModel.updateOne({ _id: user._id }, { $set: { username, lastLoginAt: now } }),
    MinecraftLinkModel.updateOne(
      { minecraftUuid: profile.uuid },
      { $set: { minecraftUsername: username } },
    ),
  ]);

  const scopes = await effectiveScopes(user._id);

  return startSession(
    ctx,
    {
      userId: user._id,
      minecraftUuid: profile.uuid,
      username,
      scopes,
    },
    { ip: meta.ip, userAgent: meta.userAgent },
    { kind: 'mc', minecraftUuid: profile.uuid },
  );
}
