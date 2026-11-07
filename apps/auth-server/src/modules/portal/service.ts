import { randomBytes } from 'node:crypto';
import type {
  AccountView,
  ActivateAccountRequest,
  ClaimAccountRequest,
  PortalChangePasswordRequest,
  PortalEmailChangeRequest,
  PortalForgotPasswordRequest,
  PortalLoginRequest,
  PortalRefreshRequest,
  PortalResetPasswordRequest,
  PortalTokenResponse,
  PortalTotpDisableRequest,
  PortalTotpEnableRequest,
  PortalTotpSetupResponse,
} from '@hotaru/api-contract';
import type { AppContext } from '../../context.js';
import { Errors } from '../../errors.js';
import {
  ActivationCodeUseModel,
  MinecraftLinkModel,
  PasswordResetTokenModel,
  RefreshTokenModel,
  SessionModel,
  UserModel,
} from '../../infrastructure/mongo/models/index.js';
import {
  ActivationCodeError,
  loadActivationPublicKey,
  verifyActivationCode,
  type ActivationPayload,
} from '../../infrastructure/activation/code.js';
import { hashPassword, verifyPassword } from '../../infrastructure/crypto/password.js';
import { generateTotpSecret, totpUri, verifyTotp } from '../../infrastructure/crypto/totp.js';
import { sendEmail } from '../../infrastructure/email/mailer.js';
import { recordAudit } from '../audit/service.js';
import { consumeBindingCode } from '../minecraft-auth/binding-code.js';
import { consumeRateLimit } from '../minecraft-auth/rate-limit.js';
import {
  bindMinecraftToAccount,
  grantDefaultScopes,
  listMinecraftLinks,
  unbindMinecraftFromAccount,
  type AccountSnapshot,
} from '../minecraft-auth/user-repository.js';
import { signPortalToken } from '../tokens/portal-token.js';
import { evaluateRefresh } from '../tokens/refresh-policy.js';
import { generateRefreshToken, hashRefreshToken } from '../tokens/refresh-token.js';
import { revokeSession } from '../tokens/service.js';
import { revocationKey } from '../../plugins/auth.js';
import { toIso } from '../users/service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

interface PortalAccountSource extends AccountSnapshot {
  loginName?: string | null;
  passwordHash?: string | null;
  email?: string | null;
  twoFactorSecret?: string | null;
  twoFactorEnabledAt?: Date | null;
  username: string;
  status: string;
  createdAt?: Date;
  lastLoginAt?: Date | null;
}

interface PortalMeta {
  ip: string | null;
  userAgent: string | null;
}

async function accountSource(accountId: string): Promise<PortalAccountSource> {
  const user = (await UserModel.findById(accountId).lean()) as PortalAccountSource | null;
  if (!user) throw Errors.unauthorized('Account not found');
  return user;
}

async function accountView(accountId: string): Promise<AccountView> {
  const user = await accountSource(accountId);
  const links = await listMinecraftLinks(accountId);
  return {
    id: String(user._id),
    username: user.username,
    loginName: user.loginName ?? user.username,
    email: user.email ?? null,
    status: user.status === 'banned' ? 'banned' : 'active',
    twoFactorEnabled: Boolean(user.twoFactorEnabledAt),
    createdAt: toIso(user.createdAt) ?? new Date(0).toISOString(),
    links,
  };
}

function activationError(error: unknown): never {
  if (error instanceof ActivationCodeError) {
    if (error.reason === 'expired') throw Errors.activationExpired();
    throw Errors.activationInvalid();
  }
  throw error;
}

async function assertCodeUnused(jti: string): Promise<void> {
  if (await ActivationCodeUseModel.exists({ jti })) throw Errors.activationUsed();
}

function normalizeEmail(email: string | undefined): string | null {
  const value = email?.trim().toLowerCase();
  return value ? value : null;
}

async function assertEmailFree(email: string | null, excludeAccountId?: string): Promise<void> {
  if (!email) return;
  const query = excludeAccountId
    ? { email, _id: { $ne: excludeAccountId } }
    : { email };
  if (await UserModel.exists(query)) throw Errors.emailExists();
}

async function assertLoginNameFree(loginName: string): Promise<void> {
  if (await UserModel.exists({ loginName })) throw Errors.accountExists();
}

async function consumeActivationUse(
  jti: string,
  type: 'account' | 'bind' | 'claim',
  accountId: string,
  minecraftUuid: string | null,
): Promise<void> {
  try {
    await ActivationCodeUseModel.create({
      jti,
      type,
      accountId,
      minecraftUuid,
      usedAt: new Date(),
    });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
      throw Errors.activationUsed();
    }
    throw error;
  }
}

export async function activateAccount(
  ctx: AppContext,
  input: ActivateAccountRequest,
  meta: PortalMeta,
): Promise<AccountView> {
  await consumeRateLimit(
    ctx.redis,
    `portal:activate:${meta.ip ?? 'unknown'}`,
    ctx.config.rateLimitVerifyMax,
    ctx.config.rateLimitWindowSeconds,
  );

  const publicKey = await loadActivationPublicKey(ctx.config);
  if (!publicKey) throw Errors.activationDisabled();

  let payload: ActivationPayload;
  try {
    payload = verifyActivationCode(input.code, publicKey);
  } catch (error) {
    activationError(error);
  }
  if (payload.type !== 'account') throw Errors.activationInvalid();
  await assertCodeUnused(payload.jti);

  const loginName = input.username.toLowerCase();
  const email = normalizeEmail(input.email);
  await assertLoginNameFree(loginName);
  await assertEmailFree(email);

  const passwordHash = await hashPassword(input.password);
  let user;
  try {
    user = await UserModel.create({
      minecraftUuid: null,
      loginName,
      passwordHash,
      email,
      username: input.username,
      status: 'active',
    });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
      const keyPattern = (error as { keyPattern?: Record<string, unknown> }).keyPattern;
      if (keyPattern?.email) throw Errors.emailExists();
      throw Errors.accountExists();
    }
    throw error;
  }

  await consumeActivationUse(payload.jti, 'account', String(user._id), null);
  await grantDefaultScopes(user._id, ctx.config.defaultScopes);
  await recordAudit(ctx, {
    event: 'account.activated',
    actorId: String(user._id),
    actorType: 'user',
    targetType: 'account',
    targetId: String(user._id),
    ip: meta.ip,
    metadata: { loginName, codeId: payload.jti },
  });

  return accountView(String(user._id));
}

export async function claimAccount(
  ctx: AppContext,
  input: ClaimAccountRequest,
  meta: PortalMeta,
): Promise<AccountView> {
  await consumeRateLimit(
    ctx.redis,
    `portal:claim:${meta.ip ?? 'unknown'}`,
    ctx.config.rateLimitVerifyMax,
    ctx.config.rateLimitWindowSeconds,
  );

  const publicKey = await loadActivationPublicKey(ctx.config);
  if (!publicKey) throw Errors.activationDisabled();

  let payload: ActivationPayload;
  try {
    payload = verifyActivationCode(input.code, publicKey);
  } catch (error) {
    activationError(error);
  }
  if (payload.type !== 'claim' || !payload.uuid) throw Errors.claimInvalid();
  await assertCodeUnused(payload.jti);

  const link = await MinecraftLinkModel.findOne({ minecraftUuid: payload.uuid }).lean();
  let user: PortalAccountSource | null = link
    ? ((await UserModel.findById(link.accountId).lean()) as PortalAccountSource | null)
    : null;
  if (!user) {
    // Legacy MC-only rows may not have been migrated yet; claim is still safe
    // because the signed code proves control of this UUID.
    user = (await UserModel.findOne({ minecraftUuid: payload.uuid })
      .lean()) as PortalAccountSource | null;
    if (user) {
      await MinecraftLinkModel.updateOne(
        { minecraftUuid: payload.uuid },
        {
          $setOnInsert: {
            accountId: user._id,
            minecraftUuid: payload.uuid,
            minecraftUsername: user.username,
            status: 'active',
            verifiedAt: new Date(),
            linkedAt: new Date(),
          },
        },
        { upsert: true },
      );
    }
  }
  if (!user) throw Errors.claimInvalid();
  if (user.loginName || user.passwordHash) throw Errors.accountAlreadyClaimed();
  if (user.status === 'banned') throw Errors.userBanned();

  const loginName = input.username.toLowerCase();
  const email = normalizeEmail(input.email);
  await assertLoginNameFree(loginName);
  await assertEmailFree(email);

  const passwordHash = await hashPassword(input.password);
  await UserModel.updateOne(
    { _id: user._id },
    {
      $set: {
        loginName,
        passwordHash,
        email,
        username: input.username,
      },
    },
  );
  await consumeActivationUse(payload.jti, 'claim', String(user._id), payload.uuid);
  await grantDefaultScopes(user._id, ctx.config.defaultScopes);
  await recordAudit(ctx, {
    event: 'account.claimed',
    actorId: String(user._id),
    actorType: 'user',
    targetType: 'account',
    targetId: String(user._id),
    ip: meta.ip,
    metadata: { loginName, minecraftUuid: payload.uuid, codeId: payload.jti },
  });

  return accountView(String(user._id));
}

async function issuePortalTokens(
  ctx: AppContext,
  user: PortalAccountSource,
  meta: PortalMeta,
): Promise<PortalTokenResponse> {
  const now = new Date();
  const session = await SessionModel.create({
    userId: user._id,
    kind: 'portal',
    minecraftUuid: null,
    expiresAt: new Date(now.getTime() + ctx.config.portalRefreshTokenTtlDays * DAY_MS),
    revokedAt: null,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  const refresh = generateRefreshToken();
  await RefreshTokenModel.create({
    sessionId: session._id,
    userId: user._id,
    tokenHash: refresh.tokenHash,
    expiresAt: session.expiresAt,
  });

  const access = await signPortalToken(ctx.keys.jwt, {
    accountId: String(user._id),
    sessionId: String(session._id),
    issuer: ctx.config.jwtIssuer,
    audience: ctx.config.portalJwtAudience,
    ttlSeconds: ctx.config.portalTokenTtlSeconds,
  });

  return {
    accessToken: access.token,
    refreshToken: refresh.token,
    tokenType: 'Bearer',
    expiresIn: access.expiresIn,
    account: await accountView(String(user._id)),
  };
}

export async function loginAccount(
  ctx: AppContext,
  input: PortalLoginRequest,
  meta: PortalMeta,
): Promise<PortalTokenResponse> {
  await consumeRateLimit(
    ctx.redis,
    `portal:login:${meta.ip ?? 'unknown'}`,
    ctx.config.rateLimitVerifyMax,
    ctx.config.rateLimitWindowSeconds,
  );

  const loginName = input.username.toLowerCase();
  const user = (await UserModel.findOne({ loginName }).lean()) as PortalAccountSource | null;
  if (!user || !(await verifyPassword(input.password, user.passwordHash ?? null))) {
    throw Errors.invalidCredentials();
  }
  if (user.status === 'banned') throw Errors.userBanned();

  if (user.twoFactorEnabledAt) {
    if (!input.totp) throw Errors.totpRequired();
    if (!user.twoFactorSecret || !verifyTotp(user.twoFactorSecret, input.totp)) {
      throw Errors.invalidTotp();
    }
  }

  const response = await issuePortalTokens(ctx, user, meta);
  await recordAudit(ctx, {
    event: 'account.login',
    actorId: String(user._id),
    actorType: 'user',
    targetType: 'account',
    targetId: String(user._id),
    ip: meta.ip,
    metadata: { loginName, twoFactor: Boolean(user.twoFactorEnabledAt) },
  });
  return response;
}

export async function refreshPortalToken(
  ctx: AppContext,
  input: PortalRefreshRequest,
  meta: PortalMeta,
): Promise<PortalTokenResponse> {
  const tokenHash = hashRefreshToken(input.refreshToken);
  const token = await RefreshTokenModel.findOne({ tokenHash }).lean();
  const session = token ? await SessionModel.findById(token.sessionId).lean() : null;
  const tokenState = token
    ? {
        usedAt: token.usedAt ?? null,
        revokedAt: token.revokedAt ?? null,
        expiresAt: token.expiresAt,
      }
    : null;
  const sessionState = session
    ? {
        revokedAt: session.revokedAt ?? null,
        expiresAt: session.expiresAt,
      }
    : null;
  const decision = evaluateRefresh({ token: tokenState, session: sessionState, nowMs: Date.now() });

  if (decision.decision === 'not-found') throw Errors.unauthorized('Refresh token is invalid');
  if (decision.decision === 'session-revoked') throw Errors.sessionRevoked();
  if (decision.decision === 'expired') throw Errors.tokenExpired();
  if (!token || !session) throw Errors.unauthorized('Refresh token is invalid');
  if (session.kind !== 'portal') throw Errors.unauthorized('Refresh token is not a portal token');

  if (decision.decision === 'reuse') {
    await revokeSession(ctx, {
      sessionId: session._id,
      reason: 'portal_refresh_reuse',
      accessTokenExpiresAt: null,
      meta,
    });
    throw Errors.refreshReused();
  }

  const user = (await UserModel.findById(session.userId).lean()) as PortalAccountSource | null;
  if (!user) throw Errors.unauthorized('Account not found');
  if (user.status === 'banned') throw Errors.userBanned();

  const replacement = generateRefreshToken();
  await RefreshTokenModel.updateOne(
    { _id: token._id, usedAt: null },
    { $set: { usedAt: new Date(), replacedByHash: replacement.tokenHash } },
  );
  await RefreshTokenModel.create({
    sessionId: session._id,
    userId: user._id,
    tokenHash: replacement.tokenHash,
    expiresAt: session.expiresAt,
  });

  const access = await signPortalToken(ctx.keys.jwt, {
    accountId: String(user._id),
    sessionId: String(session._id),
    issuer: ctx.config.jwtIssuer,
    audience: ctx.config.portalJwtAudience,
    ttlSeconds: ctx.config.portalTokenTtlSeconds,
  });

  await recordAudit(ctx, {
    event: 'account.refresh',
    actorId: String(user._id),
    actorType: 'user',
    targetType: 'account',
    targetId: String(user._id),
    ip: meta.ip,
    metadata: {},
  });

  return {
    accessToken: access.token,
    refreshToken: replacement.token,
    tokenType: 'Bearer',
    expiresIn: access.expiresIn,
    account: await accountView(String(user._id)),
  };
}

export async function getPortalAccount(accountId: string): Promise<AccountView> {
  return accountView(accountId);
}

async function verifyBindActivationCode(
  ctx: AppContext,
  code: string,
): Promise<ActivationPayload> {
  const publicKey = await loadActivationPublicKey(ctx.config);
  if (!publicKey) throw Errors.activationDisabled();
  let payload: ActivationPayload;
  try {
    payload = verifyActivationCode(code, publicKey);
  } catch (error) {
    activationError(error);
  }
  if (payload.type !== 'bind' || !payload.uuid) throw Errors.activationInvalid();
  await assertCodeUnused(payload.jti);
  return payload;
}

export async function bindMinecraft(
  ctx: AppContext,
  accountId: string,
  code: string,
  meta: PortalMeta,
): Promise<AccountView> {
  let minecraftUuid: string;
  let minecraftUsername: string;
  let activation: ActivationPayload | null = null;

  if (code.includes('.')) {
    activation = await verifyBindActivationCode(ctx, code);
    minecraftUuid = activation.uuid!;
    minecraftUsername = activation.username ?? 'unknown';
  } else {
    const consumed = await consumeBindingCode(code, accountId);
    minecraftUuid = consumed.minecraftUuid;
    minecraftUsername = consumed.minecraftUsername;
  }

  await bindMinecraftToAccount(ctx, {
    accountId,
    minecraftUuid,
    minecraftUsername,
    ip: meta.ip,
  });

  if (activation) {
    await consumeActivationUse(activation.jti, 'bind', accountId, minecraftUuid);
  }

  return accountView(accountId);
}

export async function unbindMinecraft(
  ctx: AppContext,
  accountId: string,
  minecraftUuid: string,
  meta: PortalMeta,
): Promise<AccountView> {
  const removed = await unbindMinecraftFromAccount(ctx, { accountId, minecraftUuid, ip: meta.ip });
  if (!removed) throw Errors.notFound('Minecraft link');
  return accountView(accountId);
}

async function revokeAllSessions(
  ctx: AppContext,
  userId: string,
  reason: string,
): Promise<void> {
  const now = new Date();
  const sessions = await SessionModel.find({
    userId,
    revokedAt: null,
    expiresAt: { $gt: now },
  }).lean();
  const ids = sessions.map((session) => String(session._id));
  if (ids.length === 0) return;

  await SessionModel.updateMany(
    { _id: { $in: ids } },
    { $set: { revokedAt: now, revokedReason: reason } },
  );
  await RefreshTokenModel.updateMany(
    { sessionId: { $in: ids }, revokedAt: null },
    { $set: { revokedAt: now } },
  );
  const ttl = Math.max(1, Math.floor(ctx.config.accessTokenTtlSeconds));
  await Promise.allSettled(ids.map((id) => ctx.redis.set(revocationKey(id), '1', 'EX', ttl)));
}

export async function changePassword(
  ctx: AppContext,
  accountId: string,
  input: PortalChangePasswordRequest,
  meta: PortalMeta,
): Promise<void> {
  await consumeRateLimit(
    ctx.redis,
    `portal:password:${accountId}`,
    5,
    ctx.config.rateLimitWindowSeconds,
  );

  const user = await accountSource(accountId);
  if (!(await verifyPassword(input.currentPassword, user.passwordHash ?? null))) {
    throw Errors.invalidCredentials();
  }
  const passwordHash = await hashPassword(input.newPassword);
  await UserModel.updateOne({ _id: user._id }, { $set: { passwordHash } });
  await recordAudit(ctx, {
    event: 'account.password.changed',
    actorId: String(user._id),
    actorType: 'user',
    targetType: 'account',
    targetId: String(user._id),
    ip: meta.ip,
    metadata: {},
  });
}

export async function changeEmail(
  ctx: AppContext,
  accountId: string,
  input: PortalEmailChangeRequest,
  meta: PortalMeta,
): Promise<AccountView> {
  const user = await accountSource(accountId);
  if (!(await verifyPassword(input.password, user.passwordHash ?? null))) {
    throw Errors.invalidCredentials();
  }
  const email = normalizeEmail(input.email);
  await assertEmailFree(email, accountId);
  await UserModel.updateOne({ _id: user._id }, { $set: { email } });
  await recordAudit(ctx, {
    event: 'account.email.changed',
    actorId: String(user._id),
    actorType: 'user',
    targetType: 'account',
    targetId: String(user._id),
    ip: meta.ip,
    metadata: { email },
  });
  return accountView(accountId);
}

export async function forgotPassword(
  ctx: AppContext,
  input: PortalForgotPasswordRequest,
  meta: PortalMeta,
): Promise<void> {
  await consumeRateLimit(
    ctx.redis,
    `portal:forgot:${meta.ip ?? 'unknown'}`,
    5,
    ctx.config.rateLimitWindowSeconds,
  );

  const email = normalizeEmail(input.email);
  if (!email) return;
  const user = (await UserModel.findOne({ email }).lean()) as PortalAccountSource | null;
  if (!user || !user.passwordHash) return; // Do not reveal whether the email exists.

  const rawToken = randomBytes(32).toString('base64url');
  await PasswordResetTokenModel.create({
    accountId: user._id,
    tokenHash: hashRefreshToken(rawToken),
    expiresAt: new Date(Date.now() + ctx.config.passwordResetTtlSeconds * 1000),
  });

  const link = `${ctx.config.portalBaseUrl.replace(/\/$/, '')}/?resetToken=${encodeURIComponent(rawToken)}`;
  try {
    await sendEmail(ctx.config, {
      to: email,
      subject: 'Hotaru 密码重置',
      text: `使用下面的链接重置密码，有效期 ${Math.floor(ctx.config.passwordResetTtlSeconds / 60)} 分钟：\n\n${link}`,
    });
  } catch (error) {
    // The API response stays indistinguishable from "sent"; the operator sees the failure.
    console.error('[portal] password reset email delivery failed', error);
  }
}

export async function resetPassword(
  ctx: AppContext,
  input: PortalResetPasswordRequest,
  meta: PortalMeta,
): Promise<void> {
  await consumeRateLimit(
    ctx.redis,
    `portal:reset:${meta.ip ?? 'unknown'}`,
    5,
    ctx.config.rateLimitWindowSeconds,
  );

  const tokenHash = hashRefreshToken(input.token);
  const token = await PasswordResetTokenModel.findOne({ tokenHash }).lean();
  if (!token || token.usedAt) throw Errors.resetTokenInvalid();
  if (token.expiresAt.getTime() <= Date.now()) throw Errors.resetTokenExpired();

  const user = (await UserModel.findById(token.accountId).lean()) as PortalAccountSource | null;
  if (!user) throw Errors.resetTokenInvalid();
  if (user.status === 'banned') throw Errors.userBanned();

  const passwordHash = await hashPassword(input.newPassword);
  const consumed = await PasswordResetTokenModel.findOneAndUpdate(
    { _id: token._id, usedAt: null },
    { $set: { usedAt: new Date() } },
    { new: true },
  );
  if (!consumed) throw Errors.resetTokenInvalid();

  await UserModel.updateOne({ _id: user._id }, { $set: { passwordHash } });
  await revokeAllSessions(ctx, String(user._id), 'password_reset');
  await recordAudit(ctx, {
    event: 'account.password.reset',
    actorId: String(user._id),
    actorType: 'user',
    targetType: 'account',
    targetId: String(user._id),
    ip: meta.ip,
    metadata: {},
  });
}

export async function setupTotp(
  ctx: AppContext,
  accountId: string,
): Promise<PortalTotpSetupResponse> {
  const user = await accountSource(accountId);
  if (user.twoFactorEnabledAt) throw Errors.invalidRequest('Two-factor authentication is already enabled');
  const secret = generateTotpSecret();
  await UserModel.updateOne({ _id: user._id }, { $set: { twoFactorSecret: secret } });
  return {
    secret,
    otpauthUri: totpUri(ctx.config.totpIssuer, user.loginName ?? user.username, secret),
  };
}

export async function enableTotp(
  ctx: AppContext,
  accountId: string,
  input: PortalTotpEnableRequest,
  meta: PortalMeta,
): Promise<AccountView> {
  const user = await accountSource(accountId);
  if (!user.twoFactorSecret) throw Errors.invalidTotp();
  if (!verifyTotp(user.twoFactorSecret, input.code)) throw Errors.invalidTotp();
  await UserModel.updateOne({ _id: user._id }, { $set: { twoFactorEnabledAt: new Date() } });
  await recordAudit(ctx, {
    event: 'account.2fa.enabled',
    actorId: String(user._id),
    actorType: 'user',
    targetType: 'account',
    targetId: String(user._id),
    ip: meta.ip,
    metadata: {},
  });
  return accountView(accountId);
}

export async function disableTotp(
  ctx: AppContext,
  accountId: string,
  input: PortalTotpDisableRequest,
  meta: PortalMeta,
): Promise<AccountView> {
  const user = await accountSource(accountId);
  if (!(await verifyPassword(input.currentPassword, user.passwordHash ?? null))) {
    throw Errors.invalidCredentials();
  }
  if (user.twoFactorEnabledAt) {
    if (!input.code || !user.twoFactorSecret || !verifyTotp(user.twoFactorSecret, input.code)) {
      throw Errors.invalidTotp();
    }
  }
  await UserModel.updateOne(
    { _id: user._id },
    { $set: { twoFactorSecret: null, twoFactorEnabledAt: null } },
  );
  await recordAudit(ctx, {
    event: 'account.2fa.disabled',
    actorId: String(user._id),
    actorType: 'user',
    targetType: 'account',
    targetId: String(user._id),
    ip: meta.ip,
    metadata: {},
  });
  return accountView(accountId);
}
