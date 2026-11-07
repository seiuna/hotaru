import type { FastifyRequest } from 'fastify';
import type { Types } from 'mongoose';
import type { PermissionView, Scope, UserStatus, UserView } from '@hotaru/shared-types';
import { SCOPES } from '@hotaru/shared-types';
import { Errors } from '../../errors.js';
import type { AuthContext } from '../../plugins/auth.js';
import { PermissionModel, UserModel } from '../../infrastructure/mongo/models/index.js';

/**
 * Deterministic stand-in for a missing timestamp. Documents written through the
 * Mongoose models always carry `createdAt`; this only keeps the response schema
 * satisfiable if a hand-edited/legacy document does not.
 */
export const EPOCH_ISO = new Date(0).toISOString();

/**
 * Structural shape of a lean user document. Mongoose's `InferSchemaType` does
 * not include the `timestamps` fields, so the view sources below are declared
 * structurally instead of importing Mongoose's lean-generic gymnastics.
 */
export interface UserViewSource {
  _id: Types.ObjectId | string;
  minecraftUuid: string;
  username: string;
  status?: string | null;
  createdAt?: Date | string | null;
  lastLoginAt?: Date | string | null;
}

export interface PermissionViewSource {
  scope: string;
  createdAt?: Date | string | null;
  expiresAt?: Date | string | null;
  grantedBy?: string | null;
}

/** ISO-8601 for the wire, or `null` when the value is absent/invalid. */
export function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Runtime guard against a scope that was removed from the enum after it was stored. */
export function isScope(value: string): value is Scope {
  return (SCOPES as readonly string[]).includes(value);
}

export function toUserView(user: UserViewSource): UserView {
  const status: UserStatus = user.status === 'banned' ? 'banned' : 'active';
  return {
    id: String(user._id),
    minecraftUuid: user.minecraftUuid,
    username: user.username,
    status,
    createdAt: toIso(user.createdAt) ?? EPOCH_ISO,
    lastLoginAt: toIso(user.lastLoginAt),
  };
}

/**
 * Maps a grant to the public view. Unknown scopes are dropped instead of being
 * echoed back, so a stale database value can never widen what the API claims.
 */
export function toPermissionView(permission: PermissionViewSource): PermissionView | null {
  if (!isScope(permission.scope)) return null;
  return {
    scope: permission.scope,
    grantedAt: toIso(permission.createdAt) ?? EPOCH_ISO,
    expiresAt: toIso(permission.expiresAt),
    grantedBy: permission.grantedBy ?? null,
  };
}

/** A grant is effective while it is permanent or its expiry is still in the future. */
export function isExpired(permission: Pick<PermissionView, 'expiresAt'>, now: Date = new Date()): boolean {
  if (permission.expiresAt === null) return false;
  const expiresAt = Date.parse(permission.expiresAt);
  return Number.isNaN(expiresAt) || expiresAt <= now.getTime();
}

export function effectiveScopes(permissions: readonly PermissionView[], now: Date = new Date()): Scope[] {
  return permissions.filter((permission) => !isExpired(permission, now)).map((permission) => permission.scope);
}

/**
 * The preHandler runs `authenticate()`, so `request.auth` is set; the check is
 * here so a handler that forgot the guard fails closed instead of throwing a
 * TypeError on `undefined`.
 */
export function currentAuth(request: FastifyRequest): AuthContext {
  const auth = request.auth;
  if (!auth) throw Errors.unauthorized('Authentication required');
  return auth;
}

export async function getUserView(userId: string): Promise<UserView | null> {
  const user = await UserModel.findById(userId).lean();
  return user ? toUserView(user) : null;
}

/** All granted permissions of a user, expired ones included (they stay auditable). */
export async function loadPermissionViews(userId: string): Promise<PermissionView[]> {
  const docs = await PermissionModel.find({ userId }).sort({ scope: 1 }).lean();
  return docs
    .map((doc) => toPermissionView(doc))
    .filter((view): view is PermissionView => view !== null);
}
