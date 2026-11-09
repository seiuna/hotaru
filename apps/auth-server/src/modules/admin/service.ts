import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { AnyBulkWriteOperation, FilterQuery, Types } from 'mongoose';
import { Types as MongooseTypes } from 'mongoose';
import type {
  MinecraftLinkView,
  PermissionView,
  Scope,
  UserStatus,
  UserView,
} from '@hotaru/shared-types';
import type {
  AdminActivationCodeRequest,
  AdminSetPermissionsRequest,
} from '@hotaru/api-contract';
import type { AppContext } from '../../context.js';
import { Errors } from '../../errors.js';
import { revocationKey } from '../../plugins/auth.js';
import {
  AuditLogModel,
  MinecraftLinkModel,
  PermissionModel,
  RefreshTokenModel,
  SessionModel,
  UserModel,
} from '../../infrastructure/mongo/models/index.js';
import type {
  AuditLogDoc,
  PermissionDoc,
  UserDoc,
} from '../../infrastructure/mongo/models/index.js';
import { recordAudit } from '../audit/service.js';
import {
  loadActivationPrivateKey,
  signActivationCodeWithKey,
} from '../../infrastructure/activation/code.js';
import { listMinecraftLinks } from '../minecraft-auth/user-repository.js';
import {
  EPOCH_ISO,
  effectiveScopes,
  loadPermissionViews,
  toIso,
  toUserView,
} from '../users/service.js';
import type { SessionView } from './schemas.js';

/**
 * The minimal Redis surface the revocation fan-out needs. Narrowing it to one
 * method keeps the unit tests free of an ioredis fake and documents exactly what
 * the fast path depends on.
 */
export interface RevocationStore {
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
}

export function redisRevocationStore(redis: Redis): RevocationStore {
  return {
    set: async (key, value, mode, ttlSeconds) => redis.set(key, value, mode, ttlSeconds),
  };
}

export interface AdminDeps {
  ctx: AppContext;
  store: RevocationStore;
}

/** Who performed the change; used for audit attribution and `grantedBy`. */
export interface AdminActor {
  userId: string;
  ip: string | null;
}

export interface ListUsersParams {
  query?: string | undefined;
  status?: UserStatus | undefined;
  limit: number;
  offset: number;
}

export interface ListUsersResult {
  users: UserView[];
  total: number;
  limit: number;
  offset: number;
}

export interface ReplacePermissionsResult {
  permissions: PermissionView[];
  scopes: Scope[];
}

export interface BanResult {
  user: UserView;
  sessionsRevoked: number;
}

export interface ListAuditLogsParams {
  event?: string | undefined;
  actorId?: string | undefined;
  limit: number;
  offset: number;
}

/** Structural wire sources: Mongoose's lean types omit `timestamps` fields. */
export interface AuditLogViewSource {
  _id: Types.ObjectId | string;
  event: string;
  actorId?: Types.ObjectId | string | null;
  actorType?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  ip?: string | null;
  metadata?: unknown;
  createdAt?: Date | string | null;
}

export interface SessionViewSource {
  _id: Types.ObjectId | string;
  createdAt?: Date | string | null;
  expiresAt: Date | string;
  revokedAt?: Date | string | null;
  ip?: string | null;
  userAgent?: string | null;
  clientId?: string | null;
  clientVersion?: string | null;
  clientKeyId?: string | null;
}

export interface AuditLogView {
  id: string;
  event: string;
  actorId: string | null;
  actorType: 'user' | 'admin' | 'system';
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/** Escapes user input before it reaches a MongoDB `$regex`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function toAuditLogView(doc: AuditLogViewSource): AuditLogView {
  const actorType: 'user' | 'admin' | 'system' =
    doc.actorType === 'user' || doc.actorType === 'admin' ? doc.actorType : 'system';
  const metadata =
    doc.metadata !== null && typeof doc.metadata === 'object'
      ? (doc.metadata as Record<string, unknown>)
      : null;
  return {
    id: String(doc._id),
    event: doc.event,
    actorId: doc.actorId === null || doc.actorId === undefined ? null : String(doc.actorId),
    actorType,
    targetType: doc.targetType ?? null,
    targetId: doc.targetId ?? null,
    ip: doc.ip ?? null,
    metadata,
    createdAt: toIso(doc.createdAt) ?? EPOCH_ISO,
  };
}

export function toSessionView(session: SessionViewSource): SessionView {
  return {
    id: String(session._id),
    createdAt: toIso(session.createdAt) ?? EPOCH_ISO,
    expiresAt: toIso(session.expiresAt) ?? EPOCH_ISO,
    revokedAt: toIso(session.revokedAt),
    ip: session.ip ?? null,
    userAgent: session.userAgent ?? null,
    clientId: session.clientId ?? null,
    clientVersion: session.clientVersion ?? null,
    clientKeyId: session.clientKeyId ?? null,
  };
}

/**
 * Paginated user search: `query` matches a case-insensitive username substring
 * or a Minecraft-UUID prefix (the UUID is stored dashed, so a dashed prefix is
 * what an operator pastes from logs).
 */
export async function listUsers(params: ListUsersParams): Promise<ListUsersResult> {
  const filter: FilterQuery<UserDoc> = {};
  if (params.status) filter.status = params.status;

  const needle = params.query?.trim() ?? '';
  if (needle.length > 0) {
    const pattern = escapeRegExp(needle);
    filter.$or = [
      { username: { $regex: pattern, $options: 'i' } },
      { minecraftUuid: { $regex: `^${pattern}`, $options: 'i' } },
    ];
  }

  const [total, docs] = await Promise.all([
    UserModel.countDocuments(filter),
    UserModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(params.offset)
      .limit(params.limit)
      .lean(),
  ]);

  return { users: docs.map((doc) => toUserView(doc)), total, limit: params.limit, offset: params.offset };
}

export interface NormalizedGrant {
  scope: Scope;
  expiresAt: Date | null;
}

/**
 * Turns the request list into the canonical grant set. Duplicates are rejected
 * instead of silently resolved, and an `expiresAt` in the past is a client bug
 * that must not create a grant that is dead on arrival.
 */
export function normalizeGrants(
  grants: AdminSetPermissionsRequest['permissions'],
  now: Date = new Date(),
): NormalizedGrant[] {
  const byScope = new Map<Scope, Date | null>();
  const duplicates = new Set<string>();

  for (const grant of grants) {
    if (byScope.has(grant.scope)) duplicates.add(grant.scope);

    let expiresAt: Date | null = null;
    if (grant.expiresAt !== undefined && grant.expiresAt !== null) {
      const parsed = new Date(grant.expiresAt);
      if (Number.isNaN(parsed.getTime())) {
        throw Errors.invalidRequest(`Invalid expiresAt for scope ${grant.scope}`, [
          { path: 'permissions', message: `${grant.scope}: expiresAt must be an ISO-8601 datetime` },
        ]);
      }
      if (parsed.getTime() <= now.getTime()) {
        throw Errors.invalidRequest(`expiresAt for scope ${grant.scope} must be in the future`, [
          { path: 'permissions', message: `${grant.scope}: expiresAt must be in the future` },
        ]);
      }
      expiresAt = parsed;
    }
    byScope.set(grant.scope, expiresAt);
  }

  if (duplicates.size > 0) {
    throw Errors.invalidRequest(`Duplicate scopes: ${[...duplicates].join(', ')}`, [
      { path: 'permissions', message: `duplicate scopes: ${[...duplicates].join(', ')}` },
    ]);
  }

  return [...byScope.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([scope, expiresAt]) => ({ scope, expiresAt }));
}

/**
 * Replaces the user's grants with exactly the submitted set. The deletes and the
 * upserts are issued as one ordered `bulkWrite`, so the replacement is a single
 * write batch; and because authority is never cached in a token, the next
 * request from that user (even with an already-issued JWT) sees the new set.
 */
export async function replacePermissions(
  deps: AdminDeps,
  actor: AdminActor,
  userId: string,
  grants: AdminSetPermissionsRequest['permissions'],
): Promise<ReplacePermissionsResult> {
  const user = await UserModel.findById(userId).lean();
  if (!user) throw Errors.notFound('User');

  const desired = normalizeGrants(grants);
  const desiredByScope = new Map(desired.map((grant) => [grant.scope, grant.expiresAt] as const));

  const existing = await PermissionModel.find({ userId }).lean();
  const existingByScope = new Map(existing.map((permission) => [permission.scope, permission] as const));

  const removed: string[] = [];
  const added: string[] = [];
  const updated: string[] = [];
  for (const permission of existing) {
    if (!desiredByScope.has(permission.scope)) removed.push(permission.scope);
  }
  for (const grant of desired) {
    const current = existingByScope.get(grant.scope);
    if (!current) {
      added.push(grant.scope);
      continue;
    }
    const currentExpiry = current.expiresAt instanceof Date ? current.expiresAt.getTime() : null;
    if (currentExpiry !== (grant.expiresAt?.getTime() ?? null)) updated.push(grant.scope);
  }

  // The bulk-write types demand the exact stored type (ObjectId), not its string form.
  const userObjectId = new MongooseTypes.ObjectId(userId);
  const operations: AnyBulkWriteOperation<PermissionDoc>[] = [];
  if (removed.length > 0) {
    operations.push({ deleteMany: { filter: { userId: userObjectId, scope: { $in: removed } } } });
  }
  for (const grant of desired) {
    operations.push({
      updateOne: {
        filter: { userId: userObjectId, scope: grant.scope },
        update: {
          $set: { expiresAt: grant.expiresAt, grantedBy: actor.userId },
          $setOnInsert: { userId: userObjectId, scope: grant.scope },
        },
        upsert: true,
      },
    });
  }
  if (operations.length > 0) {
    await PermissionModel.bulkWrite(operations, { ordered: true });
  }

  const permissions = await loadPermissionViews(userId);
  const scopes = effectiveScopes(permissions);

  await recordAudit(deps.ctx, {
    event: 'user.permissions.updated',
    actorId: actor.userId,
    actorType: 'admin',
    targetType: 'user',
    targetId: userId,
    ip: actor.ip,
    metadata: {
      added,
      removed,
      updated,
      permissions: desired.map((grant) => ({
        scope: grant.scope,
        expiresAt: grant.expiresAt ? grant.expiresAt.toISOString() : null,
      })),
    },
  });

  return { permissions, scopes };
}

/**
 * Bans a user and cancels every credential they already hold: all active
 * sessions are revoked in MongoDB (the guard's source of truth), the Redis
 * revocation fast-path keys are written for each session, and outstanding
 * refresh tokens of those sessions are revoked too. Idempotent: banning an
 * already-banned user keeps the original `bannedAt`.
 */
export async function banUser(
  deps: AdminDeps,
  actor: AdminActor,
  userId: string,
  reason: string | null,
): Promise<BanResult> {
  const existing = await UserModel.findById(userId).lean();
  if (!existing) throw Errors.notFound('User');

  const now = new Date();
  const alreadyBanned = existing.status === 'banned';
  const bannedAt = alreadyBanned && existing.bannedAt ? existing.bannedAt : now;
  const banReason = reason ?? (alreadyBanned ? existing.banReason ?? null : null);

  const updated = await UserModel.findByIdAndUpdate(
    userId,
    { $set: { status: 'banned', banReason, bannedAt } },
    { new: true },
  ).lean();
  if (!updated) throw Errors.notFound('User');

  const sessions = await SessionModel.find({
    userId,
    revokedAt: null,
    expiresAt: { $gt: now },
  }).lean();
  const sessionIds = sessions.map((session) => String(session._id));

  if (sessionIds.length > 0) {
    await SessionModel.updateMany(
      { _id: { $in: sessionIds } },
      { $set: { revokedAt: now, revokedReason: 'user_banned' } },
    );
    await RefreshTokenModel.updateMany(
      { sessionId: { $in: sessionIds }, revokedAt: null },
      { $set: { revokedAt: now } },
    );
  }

  // The access token expires at most `accessTokenTtlSeconds` from now, so a TTL
  // of exactly that caps how long a cached fast path could still say "valid".
  // A Redis failure cannot un-revoke the session: MongoDB is the source of truth.
  const ttlSeconds = Math.max(1, Math.floor(deps.ctx.config.accessTokenTtlSeconds));
  const revocationResults = await Promise.allSettled(
    sessionIds.map((sessionId) => deps.store.set(revocationKey(sessionId), '1', 'EX', ttlSeconds)),
  );
  const revocationKeyFailures = revocationResults.filter((result) => result.status === 'rejected').length;

  await recordAudit(deps.ctx, {
    event: 'user.banned',
    actorId: actor.userId,
    actorType: 'admin',
    targetType: 'user',
    targetId: userId,
    ip: actor.ip,
    metadata: {
      reason: banReason,
      alreadyBanned,
      sessionsRevoked: sessionIds.length,
      revocationKeyFailures,
    },
  });

  return { user: toUserView(updated), sessionsRevoked: sessionIds.length };
}

/** Lifts a ban. Idempotent; sessions revoked by the ban stay revoked. */
export async function unbanUser(
  deps: AdminDeps,
  actor: AdminActor,
  userId: string,
): Promise<{ user: UserView }> {
  const existing = await UserModel.findById(userId).lean();
  if (!existing) throw Errors.notFound('User');

  const updated = await UserModel.findByIdAndUpdate(
    userId,
    { $set: { status: 'active', banReason: null, bannedAt: null } },
    { new: true },
  ).lean();
  if (!updated) throw Errors.notFound('User');

  await recordAudit(deps.ctx, {
    event: 'user.unbanned',
    actorId: actor.userId,
    actorType: 'admin',
    targetType: 'user',
    targetId: userId,
    ip: actor.ip,
    metadata: { wasBanned: existing.status === 'banned' },
  });

  return { user: toUserView(updated) };
}

/**
 * Bans one Minecraft identity. The account stays usable in the portal and its
 * other linked UUIDs keep working; only sessions created through this UUID are
 * revoked.
 */
export async function banMinecraftLink(
  deps: AdminDeps,
  actor: AdminActor,
  userId: string,
  minecraftUuid: string,
  reason: string | null,
): Promise<{ link: MinecraftLinkView; sessionsRevoked: number }> {
  const link = await MinecraftLinkModel.findOne({ accountId: userId, minecraftUuid }).lean();
  if (!link) throw Errors.notFound('Minecraft link');

  const now = new Date();
  const updated = await MinecraftLinkModel.findOneAndUpdate(
    { _id: link._id },
    {
      $set: {
        status: 'banned',
        banReason: reason ?? link.banReason ?? null,
        bannedAt: link.bannedAt ?? now,
      },
    },
    { new: true },
  ).lean();
  if (!updated) throw Errors.notFound('Minecraft link');

  const sessions = await SessionModel.find({
    userId,
    minecraftUuid,
    revokedAt: null,
    expiresAt: { $gt: now },
  }).lean();
  const sessionIds = sessions.map((session) => String(session._id));
  if (sessionIds.length > 0) {
    await SessionModel.updateMany(
      { _id: { $in: sessionIds } },
      { $set: { revokedAt: now, revokedReason: 'uuid_banned' } },
    );
    await RefreshTokenModel.updateMany(
      { sessionId: { $in: sessionIds }, revokedAt: null },
      { $set: { revokedAt: now } },
    );
  }

  const ttlSeconds = Math.max(1, Math.floor(deps.ctx.config.accessTokenTtlSeconds));
  await Promise.allSettled(
    sessionIds.map((sessionId) => deps.store.set(revocationKey(sessionId), '1', 'EX', ttlSeconds)),
  );

  await recordAudit(deps.ctx, {
    event: 'account.link.banned',
    actorId: actor.userId,
    actorType: 'admin',
    targetType: 'minecraft_link',
    targetId: minecraftUuid,
    ip: actor.ip,
    metadata: { accountId: userId, reason, sessionsRevoked: sessionIds.length },
  });

  return {
    link: {
      uuid: updated.minecraftUuid,
      username: updated.minecraftUsername,
      status: 'banned',
      linkedAt: updated.linkedAt.toISOString(),
    },
    sessionsRevoked: sessionIds.length,
  };
}

export async function unbanMinecraftLink(
  deps: AdminDeps,
  actor: AdminActor,
  userId: string,
  minecraftUuid: string,
): Promise<{ link: MinecraftLinkView }> {
  const link = await MinecraftLinkModel.findOneAndUpdate(
    { accountId: userId, minecraftUuid },
    { $set: { status: 'active', banReason: null, bannedAt: null } },
    { new: true },
  ).lean();
  if (!link) throw Errors.notFound('Minecraft link');

  await recordAudit(deps.ctx, {
    event: 'account.link.unbanned',
    actorId: actor.userId,
    actorType: 'admin',
    targetType: 'minecraft_link',
    targetId: minecraftUuid,
    ip: actor.ip,
    metadata: { accountId: userId },
  });

  return {
    link: {
      uuid: link.minecraftUuid,
      username: link.minecraftUsername,
      status: 'active',
      linkedAt: link.linkedAt.toISOString(),
    },
  };
}
export async function revokeSession(
  deps: AdminDeps,
  actor: AdminActor,
  sessionId: string,
  reason: string | null,
): Promise<{ session: SessionView }> {
  const session = await SessionModel.findById(sessionId).lean();
  if (!session) throw Errors.notFound('Session');

  const now = new Date();
  if (!session.revokedAt) {
    await SessionModel.updateOne(
      { _id: sessionId },
      { $set: { revokedAt: now, revokedReason: reason ?? 'admin_revoked' } },
    );
    await RefreshTokenModel.updateMany({ sessionId, revokedAt: null }, { $set: { revokedAt: now } });
  }

  const ttlSeconds = Math.max(1, Math.floor(deps.ctx.config.accessTokenTtlSeconds));
  await deps.store.set(revocationKey(sessionId), '1', 'EX', ttlSeconds);

  await recordAudit(deps.ctx, {
    event: 'auth.session.revoked',
    actorId: actor.userId,
    actorType: 'admin',
    targetType: 'session',
    targetId: sessionId,
    ip: actor.ip,
    metadata: { reason, userId: String(session.userId), alreadyRevoked: Boolean(session.revokedAt) },
  });

  return { session: toSessionView({ ...session, revokedAt: session.revokedAt ?? now }) };
}

/**
 * One user plus their grants, for the detail screen. Kept as a single call so the
 * UI cannot render a user whose permissions silently failed to load.
 */
export async function issueActivationCode(
  deps: AdminDeps,
  actor: AdminActor,
  input: AdminActivationCodeRequest,
): Promise<{ code: string; type: 'account' | 'bind' | 'claim'; expiresAt: string }> {
  const privateKey = await loadActivationPrivateKey(deps.ctx.config);
  if (!privateKey) throw Errors.activationDisabled();

  if (input.type !== 'account' && !input.uuid) {
    throw Errors.invalidRequest(`--type ${input.type} requires a UUID`);
  }
  const expiresAtSeconds = Math.floor(Date.now() / 1000) + input.expiresInSeconds;
  const payload = {
    v: 1 as const,
    type: input.type,
    jti: randomUUID(),
    exp: expiresAtSeconds,
    ...(input.type === 'account' ? {} : { uuid: input.uuid as string }),
    ...(input.type === 'bind' ? { username: input.username ?? 'unknown' } : {}),
  };
  const code = signActivationCodeWithKey(payload, privateKey);

  await recordAudit(deps.ctx, {
    event: 'admin.activation_code.issued',
    actorId: actor.userId,
    actorType: 'admin',
    targetType: 'activation_code',
    targetId: payload.jti,
    ip: actor.ip,
    metadata: { type: input.type, uuid: input.uuid ?? null, expiresAt: expiresAtSeconds },
  });

  return {
    code,
    type: input.type,
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
  };
}

export async function getUserDetail(userId: string): Promise<{
  user: UserView;
  permissions: PermissionView[];
  scopes: Scope[];
  links: MinecraftLinkView[];
}> {  const user = await UserModel.findById(userId).lean();
  if (!user) throw Errors.notFound('User');

  const [permissions, links] = await Promise.all([
    loadPermissionViews(userId),
    listMinecraftLinks(userId),
  ]);
  return { user: toUserView(user), permissions, scopes: effectiveScopes(permissions), links };
}

export interface ListUserSessionsParams {  userId: string;
  limit: number;
  offset: number;
  includeRevoked: boolean;
}

export interface ListUserSessionsResult {
  sessions: SessionView[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Sessions of one user, newest first. The admin UI needs this to explain *why* a
 * token stopped working and to revoke a single device without banning the
 * account; revoked history is opt-in so the default view shows live sessions.
 */
export async function listUserSessions(
  params: ListUserSessionsParams,
): Promise<ListUserSessionsResult> {
  const user = await UserModel.findById(params.userId).lean();
  if (!user) throw Errors.notFound('User');

  const filter: FilterQuery<{ userId: string }> = { userId: params.userId };
  if (!params.includeRevoked) filter.revokedAt = null;

  const [total, docs] = await Promise.all([
    SessionModel.countDocuments(filter),
    SessionModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(params.offset)
      .limit(params.limit)
      .lean(),
  ]);

  return {
    sessions: docs.map((doc) => toSessionView(doc)),
    total,
    limit: params.limit,
    offset: params.offset,
  };
}

export interface AdminStats {
  users: { total: number; active: number; banned: number };
  sessions: { active: number };
  permissions: { total: number };
  audit: { last24h: number };
  generatedAt: string;
}

/**
 * Dashboard counters. These are cheap `countDocuments` calls with indexes behind
 * every filter (`status`, `revokedAt`+`expiresAt`, `createdAt`), so the dashboard
 * does not need a materialised stats collection.
 */
export async function adminStats(now: Date = new Date()): Promise<AdminStats> {
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [total, active, banned, activeSessions, permissionCount, last24h] = await Promise.all([
    UserModel.countDocuments({}),
    UserModel.countDocuments({ status: 'active' }),
    UserModel.countDocuments({ status: 'banned' }),
    SessionModel.countDocuments({ revokedAt: null, expiresAt: { $gt: now } }),
    PermissionModel.countDocuments({}),
    AuditLogModel.countDocuments({ createdAt: { $gte: dayAgo } }),
  ]);

  return {
    users: { total, active, banned },
    sessions: { active: activeSessions },
    permissions: { total: permissionCount },
    audit: { last24h },
    generatedAt: now.toISOString(),
  };
}

/** Newest-first audit log with exact-match filters. */export async function listAuditLogs(params: ListAuditLogsParams): Promise<{
  logs: AuditLogView[];
  total: number;
  limit: number;
  offset: number;
}> {
  const filter: FilterQuery<AuditLogDoc> = {};
  if (params.event) filter.event = params.event;
  if (params.actorId) filter.actorId = new MongooseTypes.ObjectId(params.actorId);

  const [total, docs] = await Promise.all([
    AuditLogModel.countDocuments(filter),
    AuditLogModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(params.offset)
      .limit(params.limit)
      .lean(),
  ]);

  return {
    logs: docs.map((doc) => toAuditLogView(doc)),
    total,
    limit: params.limit,
    offset: params.offset,
  };
}
