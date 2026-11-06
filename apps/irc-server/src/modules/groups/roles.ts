import type { GroupRole } from '../../runtime/contracts.js';

/**
 * The group role matrix (design §9.2), as data plus three pure predicates.
 *
 * Everything a group can decide is expressed here so the service never
 * hand-rolls a role comparison and the matrix can be tested cell by cell:
 *
 * | action                    | OWNER | ADMIN | MEMBER |
 * | ------------------------- | ----- | ----- | ------ |
 * | view group / members      |   ✓   |   ✓   |   ✓    |
 * | send a group message      |   ✓   |   ✓   |   ✓    |
 * | edit name/visibility/cap  |   ✓   |   ✓   |   –    |
 * | invite / remove members   |   ✓   |   ✓   |   –    |
 * | edit group filters        |   ✓   |   ✓   |   –    |
 * | promote/demote a member   |   ✓   |   –   |   –    |
 * | delete the group          |   ✓   |   –   |   –    |
 *
 * Ownership transfer is deliberately absent: v1 has no transfer operation, so a
 * group always has exactly one OWNER and it can only be dissolved, never handed
 * over. That also removes the "two owners" race from the write path.
 */

export const GROUP_ROLES: readonly GroupRole[] = ['OWNER', 'ADMIN', 'MEMBER'];

export interface GroupPermissions {
  readonly canEditGroup: boolean;
  readonly canManageMembers: boolean;
  readonly canChangeRoles: boolean;
  readonly canEditFilters: boolean;
  readonly canDeleteGroup: boolean;
  readonly canSend: boolean;
}

const OWNER_PERMISSIONS: GroupPermissions = Object.freeze({
  canEditGroup: true,
  canManageMembers: true,
  canChangeRoles: true,
  canEditFilters: true,
  canDeleteGroup: true,
  canSend: true,
});

const ADMIN_PERMISSIONS: GroupPermissions = Object.freeze({
  canEditGroup: true,
  canManageMembers: true,
  canChangeRoles: false,
  canEditFilters: true,
  canDeleteGroup: false,
  canSend: true,
});

const MEMBER_PERMISSIONS: GroupPermissions = Object.freeze({
  canEditGroup: false,
  canManageMembers: false,
  canChangeRoles: false,
  canEditFilters: false,
  canDeleteGroup: false,
  canSend: true,
});

export const ROLE_PERMISSIONS: Readonly<Record<GroupRole, GroupPermissions>> = Object.freeze({
  OWNER: OWNER_PERMISSIONS,
  ADMIN: ADMIN_PERMISSIONS,
  MEMBER: MEMBER_PERMISSIONS,
});

/** Permissions of a role; an unknown/corrupt role degrades to the least privilege. */
export function permissionsFor(role: GroupRole): GroupPermissions {
  const permissions: GroupPermissions | undefined = ROLE_PERMISSIONS[role];
  return permissions ?? MEMBER_PERMISSIONS;
}

export function isGroupRole(value: unknown): value is GroupRole {
  return value === 'OWNER' || value === 'ADMIN' || value === 'MEMBER';
}

/**
 * May `actorRole` create a membership with `requestedRole`?
 *
 * Only the owner can mint admins — otherwise any admin could promote themselves
 * a peer, and two admins could jointly outvote the owner. Nobody can create a
 * second OWNER (`addMember` cannot express it and `setMemberRole` rejects it).
 */
export function canAssignRole(actorRole: GroupRole, requestedRole: GroupRole): boolean {
  if (requestedRole === 'OWNER') return false;
  if (actorRole === 'OWNER') return true;
  if (actorRole === 'ADMIN') return requestedRole === 'MEMBER';
  return false;
}

/**
 * May `actorRole` remove a member whose role is `targetRole`?
 *
 * Self-removal is "leaving": any non-owner may leave, the owner must delete the
 * group (there is nobody to inherit it). Admins never remove peers or the owner.
 */
export function canRemoveMember(actorRole: GroupRole, targetRole: GroupRole, isSelf: boolean): boolean {
  if (isSelf) return actorRole !== 'OWNER';
  if (actorRole === 'OWNER') return targetRole !== 'OWNER';
  if (actorRole === 'ADMIN') return targetRole === 'MEMBER';
  return false;
}

/**
 * May `actorRole` move a member to `nextRole`?
 *
 * Role changes are owner-only: promotion is privilege escalation, and "an admin
 * may edit filters" is already the most an admin is trusted with. A self-change
 * is never allowed — the owner demoting themselves would leave the group
 * ownerless, and there is no transfer operation to recover from it.
 */
export function canChangeRole(
  actorRole: GroupRole,
  targetRole: GroupRole,
  nextRole: GroupRole,
  isSelf: boolean,
): boolean {
  if (nextRole === 'OWNER') return false;
  if (isSelf) return false;
  if (actorRole !== 'OWNER') return false;
  return targetRole === 'MEMBER' || targetRole === 'ADMIN';
}
