import type { Types } from 'mongoose';
import type { TokenResponse } from '@hotaru/api-contract';
import type { Scope } from '@hotaru/shared-types';
import type { AppContext } from '../../context.js';
import { Errors } from '../../errors.js';
import {
  RefreshTokenModel,
  SessionModel,
  UserModel,
} from '../../infrastructure/mongo/models/index.js';
import { revocationKey } from '../../plugins/auth.js';
import { recordAudit } from '../audit/service.js';
import { signAccessToken } from './access-token.js';
import { evaluateRefresh } from './refresh-policy.js';
import { generateRefreshToken, hashRefreshToken } from './refresh-token.js';
import { effectiveScopes } from './scopes.js';

export interface SessionIdentity {
  userId: Types.ObjectId;
  minecraftUuid: string;
  username: string;
  scopes: readonly Scope[];
}

export interface SessionRequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface SessionOptions {
  kind?: 'mc' | 'portal';
  minecraftUuid?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Seconds a revocation key must live so it outlives the access token it kills. */
function revocationTtlSeconds(expiresAt: Date | null, fallbackSeconds: number): number {
  if (!expiresAt) return Math.max(1, Math.floor(fallbackSeconds));
  const remaining = Math.ceil((expiresAt.getTime() - Date.now()) / 1000);
  return remaining > 0 ? remaining : 1;
}

/**
 * Creates the session row plus the first refresh token and signs the access
 * token. The refresh token plaintext leaves this function exactly once.
 */
export async function startSession(
  ctx: AppContext,
  identity: SessionIdentity,
  meta: SessionRequestMeta,
  options: SessionOptions = {},
): Promise<TokenResponse> {
  const now = new Date();
  const sessionExpiresAt = new Date(now.getTime() + ctx.config.refreshTokenTtlDays * DAY_MS);

  const session = await SessionModel.create({
    userId: identity.userId,
    kind: options.kind ?? 'mc',
    minecraftUuid: options.minecraftUuid ?? identity.minecraftUuid,
    expiresAt: sessionExpiresAt,
    revokedAt: null,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  const refresh = generateRefreshToken();
  await RefreshTokenModel.create({
    sessionId: session._id,
    userId: identity.userId,
    tokenHash: refresh.tokenHash,
    expiresAt: sessionExpiresAt,
  });

  const access = await signAccessToken(ctx.keys.jwt, {
    userId: String(identity.userId),
    minecraftUuid: identity.minecraftUuid,
    sessionId: String(session._id),
    scopes: identity.scopes,
    issuer: ctx.config.jwtIssuer,
    audience: ctx.config.jwtAudience,
    ttlSeconds: ctx.config.accessTokenTtlSeconds,
  });

  await recordAudit(ctx, {
    event: 'auth.session.created',
    actorId: String(identity.userId),
    actorType: 'user',
    targetType: 'session',
    targetId: String(session._id),
    ip: meta.ip,
    metadata: { minecraftUuid: identity.minecraftUuid, scopes: [...identity.scopes] },
  });

  return {
    accessToken: access.token,
    refreshToken: refresh.token,
    tokenType: 'Bearer',
    expiresIn: access.expiresIn,
    profile: { uuid: identity.minecraftUuid, username: identity.username },
    scopes: [...identity.scopes],
  };
}

/** Revokes a session, every outstanding refresh token and writes the Redis fast path. */
export async function revokeSession(
  ctx: AppContext,
  input: {
    sessionId: Types.ObjectId;
    reason: string;
    /** `exp` of the access token that triggered the revocation, when known. */
    accessTokenExpiresAt: Date | null;
    meta: SessionRequestMeta;
  },
): Promise<void> {
  const now = new Date();

  const result = await SessionModel.updateOne(
    { _id: input.sessionId, revokedAt: null },
    { $set: { revokedAt: now, revokedReason: input.reason } },
  );

  await RefreshTokenModel.updateMany(
    { sessionId: input.sessionId, revokedAt: null },
    { $set: { revokedAt: now } },
  );

  const ttl = revocationTtlSeconds(input.accessTokenExpiresAt, ctx.config.accessTokenTtlSeconds);
  await ctx.redis.set(revocationKey(String(input.sessionId)), '1', 'EX', ttl);

  await recordAudit(ctx, {
    event: 'auth.session.revoked',
    actorType: 'user',
    targetType: 'session',
    targetId: String(input.sessionId),
    ip: input.meta.ip,
    metadata: { reason: input.reason, alreadyRevoked: result.modifiedCount === 0 },
  });
}

/**
 * Rotates a refresh token: the presented token is marked used exactly once
 * (atomic compare-and-set), a replacement is issued in the same session, and a
 * replay of an already-used token revokes the whole session.
 */
export async function rotateRefreshToken(
  ctx: AppContext,
  rawToken: string,
  meta: SessionRequestMeta,
): Promise<TokenResponse> {
  const tokenHash = hashRefreshToken(rawToken);
  const token = await RefreshTokenModel.findOne({ tokenHash }).lean();
  const session = token ? await SessionModel.findById(token.sessionId).lean() : null;

  const evaluation = evaluateRefresh({
    token: token
      ? {
          usedAt: token.usedAt ?? null,
          revokedAt: token.revokedAt ?? null,
          expiresAt: token.expiresAt,
        }
      : null,
    session: session
      ? { revokedAt: session.revokedAt ?? null, expiresAt: session.expiresAt }
      : null,
    nowMs: Date.now(),
  });

  switch (evaluation.decision) {
    case 'not-found':
      throw Errors.unauthorized('Refresh token is not recognised');
    case 'session-revoked':
      throw Errors.sessionRevoked();
    case 'expired':
      throw Errors.unauthorized('Refresh token has expired');
    case 'reuse':
      if (!token || !session) throw Errors.unauthorized('Refresh token is not recognised');
      await revokeReusedSession(ctx, token.sessionId, session.userId, meta);
      throw Errors.refreshReused();
    case 'rotate':
      break;
  }

  if (!token || !session) throw Errors.unauthorized('Refresh token is not recognised');

  const user = await UserModel.findById(token.userId).lean();
  if (!user) {
    await revokeSession(ctx, {
      sessionId: session._id,
      reason: 'user_missing',
      accessTokenExpiresAt: null,
      meta,
    });
    throw Errors.unauthorized('User not found');
  }
  if (user.status === 'banned') {
    await revokeSession(ctx, {
      sessionId: session._id,
      reason: 'user_banned',
      accessTokenExpiresAt: null,
      meta,
    });
    await recordAudit(ctx, {
      event: 'auth.login.banned',
      actorId: String(user._id),
      actorType: 'user',
      targetType: 'user',
      targetId: String(user._id),
      ip: meta.ip,
      metadata: { minecraftUuid: user.minecraftUuid ?? null, stage: 'refresh' },
    });
    throw Errors.userBanned();
  }

  const minecraftUuid = session.minecraftUuid ?? user.minecraftUuid;
  if (!minecraftUuid) throw Errors.unauthorized('Session has no Minecraft identity');

  const replacement = generateRefreshToken();
  const claimed = await RefreshTokenModel.findOneAndUpdate(
    { _id: token._id, usedAt: null, revokedAt: null },
    { $set: { usedAt: new Date(), replacedByHash: replacement.tokenHash } },
    { new: true },
  ).lean();

  if (!claimed) {
    // Lost the race with a concurrent rotation: same credential used twice.
    await revokeReusedSession(ctx, token.sessionId, token.userId, meta);
    throw Errors.refreshReused();
  }

  await RefreshTokenModel.create({
    sessionId: session._id,
    userId: token.userId,
    tokenHash: replacement.tokenHash,
    expiresAt: session.expiresAt,
  });

  const scopes = await effectiveScopes(user._id);
  const access = await signAccessToken(ctx.keys.jwt, {
    userId: String(user._id),
    minecraftUuid,
    sessionId: String(session._id),
    scopes,
    issuer: ctx.config.jwtIssuer,
    audience: ctx.config.jwtAudience,
    ttlSeconds: ctx.config.accessTokenTtlSeconds,
  });

  await recordAudit(ctx, {
    event: 'auth.session.refreshed',
    actorId: String(user._id),
    actorType: 'user',
    targetType: 'session',
    targetId: String(session._id),
    ip: meta.ip,
  });

  return {
    accessToken: access.token,
    refreshToken: replacement.token,
    tokenType: 'Bearer',
    expiresIn: access.expiresIn,
    profile: { uuid: minecraftUuid, username: user.username },
    scopes,
  };
}

/** Kills the session and records the reuse event before surfacing REFRESH_REUSED. */
async function revokeReusedSession(
  ctx: AppContext,
  sessionId: Types.ObjectId,
  userId: Types.ObjectId,
  meta: SessionRequestMeta,
): Promise<void> {
  await revokeSession(ctx, {
    sessionId,
    reason: 'refresh_token_reuse',
    accessTokenExpiresAt: null,
    meta,
  });
  await recordAudit(ctx, {
    event: 'auth.refresh.reused',
    actorId: String(userId),
    actorType: 'user',
    targetType: 'session',
    targetId: String(sessionId),
    ip: meta.ip,
  });
}
