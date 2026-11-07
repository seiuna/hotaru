import type {
  AccountView,
  ActivateAccountRequest,
  PortalChangePasswordRequest,
  PortalLoginRequest,
  PortalTokenResponse,
} from '@hotaru/api-contract';
import type { AppContext } from '../../context.js';
import { Errors } from '../../errors.js';
import {
  ActivationCodeUseModel,
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
import { toIso } from '../users/service.js';

interface PortalAccountSource extends AccountSnapshot {
  loginName?: string | null;
  passwordHash?: string | null;
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
    status: user.status === 'banned' ? 'banned' : 'active',
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
  if (await UserModel.exists({ loginName })) throw Errors.accountExists();

  const passwordHash = await hashPassword(input.password);
  let user;
  try {
    user = await UserModel.create({
      minecraftUuid: null,
      loginName,
      passwordHash,
      username: input.username,
      status: 'active',
    });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
      throw Errors.accountExists();
    }
    throw error;
  }

  try {
    await ActivationCodeUseModel.create({
      jti: payload.jti,
      type: 'account',
      accountId: user._id,
      usedAt: new Date(),
    });
  } catch (error) {
    await UserModel.deleteOne({ _id: user._id });
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
      throw Errors.activationUsed();
    }
    throw error;
  }

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

  const now = new Date();
  const session = await SessionModel.create({
    userId: user._id,
    kind: 'portal',
    minecraftUuid: null,
    expiresAt: new Date(now.getTime() + ctx.config.portalTokenTtlSeconds * 1000),
    revokedAt: null,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  const token = await signPortalToken(ctx.keys.jwt, {
    accountId: String(user._id),
    sessionId: String(session._id),
    issuer: ctx.config.jwtIssuer,
    audience: ctx.config.portalJwtAudience,
    ttlSeconds: ctx.config.portalTokenTtlSeconds,
  });

  await recordAudit(ctx, {
    event: 'account.login',
    actorId: String(user._id),
    actorType: 'user',
    targetType: 'account',
    targetId: String(user._id),
    ip: meta.ip,
    metadata: { loginName },
  });

  return {
    accessToken: token.token,
    tokenType: 'Bearer',
    expiresIn: token.expiresIn,
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
    try {
      await ActivationCodeUseModel.create({
        jti: activation.jti,
        type: 'bind',
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

  const user = (await UserModel.findById(accountId).lean()) as PortalAccountSource | null;
  if (!user) throw Errors.unauthorized('Account not found');
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
