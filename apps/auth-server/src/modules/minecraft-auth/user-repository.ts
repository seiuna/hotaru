import type { Types } from 'mongoose';
import type { MinecraftLinkView } from '@hotaru/shared-types';
import type { AppContext } from '../../context.js';
import { Errors } from '../../errors.js';
import { MinecraftLinkModel, PermissionModel, UserModel } from '../../infrastructure/mongo/models/index.js';
import { recordAudit } from '../audit/service.js';
import { isScope } from '../tokens/scopes.js';

export interface AccountSnapshot {
  _id: Types.ObjectId;
  minecraftUuid?: string | null;
  username: string;
  status: string;
  createdAt?: Date;
  lastLoginAt?: Date | null;
}

export interface LinkSnapshot {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  minecraftUuid: string;
  minecraftUsername: string;
  status: string;
  linkedAt: Date;
  verifiedAt: Date;
  banReason?: string | null;
  bannedAt?: Date | null;
}

export interface LinkedAccount {
  link: LinkSnapshot;
  user: AccountSnapshot;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 11000
  );
}

function toLinkView(link: LinkSnapshot): MinecraftLinkView {
  return {
    uuid: link.minecraftUuid,
    username: link.minecraftUsername,
    status: link.status === 'banned' ? 'banned' : 'active',
    linkedAt: link.linkedAt.toISOString(),
  };
}

/**
 * Resolves a Mojang UUID to its account. Legacy rows that predate the link
 * collection are linked lazily on their next login, so existing players keep
 * working without a migration outage.
 */
export async function findLinkedAccount(minecraftUuid: string): Promise<LinkedAccount | null> {
  const link = (await MinecraftLinkModel.findOne({ minecraftUuid }).lean()) as LinkSnapshot | null;
  if (link) {
    const user = (await UserModel.findById(link.accountId).lean()) as AccountSnapshot | null;
    return user ? { link, user } : null;
  }

  const legacy = (await UserModel.findOne({ minecraftUuid }).lean()) as AccountSnapshot | null;
  if (!legacy) return null;

  const now = new Date();
  const created = (await MinecraftLinkModel.findOneAndUpdate(
    { minecraftUuid },
    {
      $setOnInsert: {
        accountId: legacy._id,
        minecraftUuid,
        minecraftUsername: legacy.username,
        status: 'active',
        verifiedAt: now,
        linkedAt: now,
      },
    },
    { upsert: true, new: true },
  ).lean()) as LinkSnapshot;
  return { link: created, user: legacy };
}

export async function listMinecraftLinks(accountId: string): Promise<MinecraftLinkView[]> {
  const links = (await MinecraftLinkModel.find({ accountId })
    .sort({ linkedAt: 1 })
    .lean()) as LinkSnapshot[];
  return links.map(toLinkView);
}

export async function bindMinecraftToAccount(
  ctx: AppContext,
  input: { accountId: string; minecraftUuid: string; minecraftUsername: string; ip: string | null },
): Promise<LinkSnapshot> {
  const existing = (await MinecraftLinkModel.findOne({
    minecraftUuid: input.minecraftUuid,
  }).lean()) as LinkSnapshot | null;

  if (existing) {
    if (String(existing.accountId) === input.accountId) return existing;
    throw Errors.linkAlreadyBound();
  }

  const legacyOwner = (await UserModel.findOne({
    minecraftUuid: input.minecraftUuid,
    _id: { $ne: input.accountId },
  }).lean()) as AccountSnapshot | null;
  if (legacyOwner) throw Errors.linkAlreadyBound();

  const now = new Date();
  let link: LinkSnapshot;
  try {
    link = (await MinecraftLinkModel.create({
      accountId: input.accountId,
      minecraftUuid: input.minecraftUuid,
      minecraftUsername: input.minecraftUsername,
      status: 'active',
      verifiedAt: now,
      linkedAt: now,
    })).toObject() as LinkSnapshot;
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    const winner = (await MinecraftLinkModel.findOne({
      minecraftUuid: input.minecraftUuid,
    }).lean()) as LinkSnapshot | null;
    if (winner && String(winner.accountId) === input.accountId) return winner;
    throw Errors.linkAlreadyBound();
  }

  await UserModel.updateOne(
    { _id: input.accountId, $or: [{ minecraftUuid: null }, { minecraftUuid: { $exists: false } }] },
    { $set: { minecraftUuid: input.minecraftUuid } },
  );

  await recordAudit(ctx, {
    event: 'account.link.created',
    actorType: 'system',
    targetType: 'minecraft_link',
    targetId: input.minecraftUuid,
    ip: input.ip,
    metadata: { accountId: input.accountId, minecraftUuid: input.minecraftUuid },
  });

  return link;
}

export async function unbindMinecraftFromAccount(
  ctx: AppContext,
  input: { accountId: string; minecraftUuid: string; ip: string | null },
): Promise<boolean> {
  const deleted = await MinecraftLinkModel.deleteOne({
    accountId: input.accountId,
    minecraftUuid: input.minecraftUuid,
  });
  if (deleted.deletedCount === 0) return false;

  const replacement = (await MinecraftLinkModel.findOne({ accountId: input.accountId })
    .sort({ linkedAt: 1 })
    .lean()) as LinkSnapshot | null;
  await UserModel.updateOne(
    { _id: input.accountId, minecraftUuid: input.minecraftUuid },
    { $set: { minecraftUuid: replacement?.minecraftUuid ?? null } },
  );

  await recordAudit(ctx, {
    event: 'account.link.removed',
    actorType: 'system',
    targetType: 'minecraft_link',
    targetId: input.minecraftUuid,
    ip: input.ip,
    metadata: { accountId: input.accountId, minecraftUuid: input.minecraftUuid },
  });
  return true;
}

/** Throws USER_BANNED for a banned account; checked before creating any session. */
export async function assertAccountNotBanned(
  ctx: AppContext,
  user: AccountSnapshot,
  ip: string | null,
): Promise<void> {
  if (user.status !== 'banned') return;
  await recordAudit(ctx, {
    event: 'auth.login.banned',
    actorId: String(user._id),
    actorType: 'user',
    targetType: 'user',
    targetId: String(user._id),
    ip,
    metadata: { minecraftUuid: user.minecraftUuid ?? null, stage: 'login' },
  });
  throw Errors.userBanned();
}

/**
 * Grants configured default scopes on first login. Upserts keep it idempotent
 * under concurrent first logins; `$setOnInsert` never resurrects a grant an
 * administrator removed.
 */
export async function grantDefaultScopes(
  userId: Types.ObjectId,
  scopes: readonly string[],
): Promise<void> {
  const grants = [...new Set(scopes)].filter(isScope);
  if (grants.length === 0) return;

  await PermissionModel.bulkWrite(
    grants.map((scope) => ({
      updateOne: {
        filter: { userId, scope },
        update: { $setOnInsert: { userId, scope, expiresAt: null, grantedBy: null } },
        upsert: true,
      },
    })),
    { ordered: false },
  );
}
