import type { Types } from 'mongoose';
import { SCOPES, type Scope } from '@hotaru/shared-types';
import { PermissionModel } from '../../infrastructure/mongo/models/index.js';

const SCOPE_SET: ReadonlySet<string> = new Set<string>(SCOPES);

export function isScope(value: string): value is Scope {
  return SCOPE_SET.has(value);
}

/**
 * Effective scopes = granted by MongoDB and not expired. This is the only
 * source of truth for authorization; token claims are informational.
 */
export async function effectiveScopes(userId: Types.ObjectId): Promise<Scope[]> {
  const now = new Date();
  const permissions = await PermissionModel.find({
    userId,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  })
    .select({ scope: 1 })
    .lean();

  return permissions.map((permission) => permission.scope).filter(isScope);
}
