import type { Types } from 'mongoose';
import type { AppContext } from '../../context.js';
import { Errors } from '../../errors.js';
import { PermissionModel, UserModel } from '../../infrastructure/mongo/models/index.js';
import { recordAudit } from '../audit/service.js';
import { isScope } from '../tokens/scopes.js';

export interface EnsuredUser {
  userId: Types.ObjectId;
  minecraftUuid: string;
  username: string;
  /** True only for the request that created the row (default scopes were granted). */
  created: boolean;
}

interface UserSnapshot {
  _id: Types.ObjectId;
  minecraftUuid: string;
  username: string;
  status: string;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 11000
  );
}

/**
 * Upserts the user keyed on the **Mojang-verified** UUID. Usernames are display
 * data only (players rename), so they are updated, never used as a key.
 *
 * Throws USER_BANNED for a banned account; that check is deliberately before
 * any session is created.
 */
export async function ensureUser(
  ctx: AppContext,
  input: {
    minecraftUuid: string;
    username: string;
    defaultScopes: readonly string[];
    ip: string | null;
  },
): Promise<EnsuredUser> {
  const now = new Date();
  const existing = (await UserModel.findOne({ minecraftUuid: input.minecraftUuid }).lean()) as
    | UserSnapshot
    | null;

  if (existing) {
    await assertNotBanned(ctx, existing, input.ip);
    await UserModel.updateOne(
      { _id: existing._id },
      { $set: { username: input.username, lastLoginAt: now } },
    );
    return {
      userId: existing._id,
      minecraftUuid: existing.minecraftUuid,
      username: input.username,
      created: false,
    };
  }

  try {
    const created = await UserModel.create({
      minecraftUuid: input.minecraftUuid,
      username: input.username,
      status: 'active',
      lastLoginAt: now,
    });
    await grantDefaultScopes(created._id, input.defaultScopes);
    return {
      userId: created._id,
      minecraftUuid: created.minecraftUuid,
      username: created.username,
      created: true,
    };
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    // Lost the insert race: the winner's row is authoritative.
    const winner = (await UserModel.findOne({ minecraftUuid: input.minecraftUuid }).lean()) as
      | UserSnapshot
      | null;
    if (!winner) throw error;
    await assertNotBanned(ctx, winner, input.ip);
    await UserModel.updateOne(
      { _id: winner._id },
      { $set: { username: input.username, lastLoginAt: now } },
    );
    return {
      userId: winner._id,
      minecraftUuid: winner.minecraftUuid,
      username: input.username,
      created: false,
    };
  }
}

async function assertNotBanned(
  ctx: AppContext,
  user: UserSnapshot,
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
    metadata: { minecraftUuid: user.minecraftUuid, stage: 'login' },
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
