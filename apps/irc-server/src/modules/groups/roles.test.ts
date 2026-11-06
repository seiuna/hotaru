import { describe, expect, it } from 'vitest';
import type { GroupRole } from '../../runtime/contracts.js';
import {
  GROUP_ROLES,
  ROLE_PERMISSIONS,
  canAssignRole,
  canChangeRole,
  canRemoveMember,
  isGroupRole,
  permissionsFor,
} from './roles.js';

/**
 * The role matrix is a security boundary, so every cell is asserted explicitly
 * rather than derived from the same expression the implementation uses.
 */

describe('role permissions matrix (design §9.2)', () => {
  const expectations: Record<GroupRole, Record<string, boolean>> = {
    OWNER: {
      canEditGroup: true,
      canManageMembers: true,
      canChangeRoles: true,
      canEditFilters: true,
      canDeleteGroup: true,
      canSend: true,
    },
    ADMIN: {
      canEditGroup: true,
      canManageMembers: true,
      canChangeRoles: false,
      canEditFilters: true,
      canDeleteGroup: false,
      canSend: true,
    },
    MEMBER: {
      canEditGroup: false,
      canManageMembers: false,
      canChangeRoles: false,
      canEditFilters: false,
      canDeleteGroup: false,
      canSend: true,
    },
  };

  for (const role of GROUP_ROLES) {
    it(`${role} has exactly the documented permissions`, () => {
      expect(permissionsFor(role)).toEqual(expectations[role]);
      expect(ROLE_PERMISSIONS[role]).toEqual(expectations[role]);
    });
  }

  it('only ADMIN may not delete; only OWNER may change roles', () => {
    expect(permissionsFor('ADMIN').canDeleteGroup).toBe(false);
    expect(permissionsFor('ADMIN').canChangeRoles).toBe(false);
    expect(permissionsFor('MEMBER').canSend).toBe(true);
  });

  it('degrades an unknown role to the least privilege instead of throwing', () => {
    expect(permissionsFor('SUPERUSER' as GroupRole)).toEqual(expectations['MEMBER']);
  });

  it('recognises only the three roles', () => {
    expect(isGroupRole('OWNER')).toBe(true);
    expect(isGroupRole('ADMIN')).toBe(true);
    expect(isGroupRole('MEMBER')).toBe(true);
    expect(isGroupRole('owner')).toBe(false);
    expect(isGroupRole('')).toBe(false);
    expect(isGroupRole(undefined)).toBe(false);
  });
});

describe('canAssignRole (invite)', () => {
  const cases: Array<[GroupRole, GroupRole, boolean]> = [
    // OWNER may invite an ADMIN or a MEMBER, never a second OWNER.
    ['OWNER', 'ADMIN', true],
    ['OWNER', 'MEMBER', true],
    ['OWNER', 'OWNER', false],
    // ADMIN may invite plain members only (no peer promotion).
    ['ADMIN', 'ADMIN', false],
    ['ADMIN', 'MEMBER', true],
    ['ADMIN', 'OWNER', false],
    // MEMBER may invite nobody.
    ['MEMBER', 'ADMIN', false],
    ['MEMBER', 'MEMBER', false],
    ['MEMBER', 'OWNER', false],
  ];

  for (const [actorRole, requestedRole, expected] of cases) {
    it(`${actorRole} inviting ${requestedRole} -> ${String(expected)}`, () => {
      expect(canAssignRole(actorRole, requestedRole)).toBe(expected);
    });
  }
});

describe('canRemoveMember (invite/remove matrix)', () => {
  const cases: Array<[GroupRole, GroupRole, boolean, boolean]> = [
    // [actorRole, targetRole, isSelf, expected]
    ['OWNER', 'ADMIN', false, true],
    ['OWNER', 'MEMBER', false, true],
    ['OWNER', 'OWNER', false, false],
    // An owner leaves by deleting the group: there is nobody to inherit it.
    ['OWNER', 'OWNER', true, false],
    ['ADMIN', 'MEMBER', false, true],
    ['ADMIN', 'ADMIN', false, false],
    ['ADMIN', 'OWNER', false, false],
    // Leaving is allowed for everyone except the owner.
    ['ADMIN', 'ADMIN', true, true],
    ['MEMBER', 'MEMBER', true, true],
    ['MEMBER', 'MEMBER', false, false],
    ['MEMBER', 'ADMIN', false, false],
  ];

  for (const [actorRole, targetRole, isSelf, expected] of cases) {
    it(`${actorRole} removing ${targetRole} (self=${String(isSelf)}) -> ${String(expected)}`, () => {
      expect(canRemoveMember(actorRole, targetRole, isSelf)).toBe(expected);
    });
  }
});

describe('canChangeRole (owner-only role changes, no transfer)', () => {
  const cases: Array<[GroupRole, GroupRole, GroupRole, boolean, boolean]> = [
    // [actorRole, targetRole, nextRole, isSelf, expected]
    ['OWNER', 'MEMBER', 'ADMIN', false, true],
    ['OWNER', 'ADMIN', 'MEMBER', false, true],
    ['OWNER', 'MEMBER', 'MEMBER', false, true],
    ['OWNER', 'ADMIN', 'ADMIN', false, true],
    // No self-change: an owner demoting themselves would orphan the group.
    ['OWNER', 'OWNER', 'ADMIN', true, false],
    ['OWNER', 'OWNER', 'MEMBER', true, false],
    // Ownership is not assignable in v1.
    ['OWNER', 'MEMBER', 'OWNER', false, false],
    ['OWNER', 'ADMIN', 'OWNER', false, false],
    // Admins never change roles (peer promotion).
    ['ADMIN', 'MEMBER', 'ADMIN', false, false],
    ['ADMIN', 'MEMBER', 'MEMBER', false, false],
    ['ADMIN', 'ADMIN', 'MEMBER', false, false],
    // Members never change roles.
    ['MEMBER', 'MEMBER', 'ADMIN', false, false],
    ['MEMBER', 'MEMBER', 'MEMBER', false, false],
  ];

  for (const [actorRole, targetRole, nextRole, isSelf, expected] of cases) {
    it(`${actorRole} changing ${targetRole} -> ${nextRole} (self=${String(isSelf)}) -> ${String(expected)}`, () => {
      expect(canChangeRole(actorRole, targetRole, nextRole, isSelf)).toBe(expected);
    });
  }

  it('never allows an ADMIN or MEMBER to change any role', () => {
    for (const actorRole of ['ADMIN', 'MEMBER'] as const) {
      for (const targetRole of GROUP_ROLES) {
        for (const nextRole of GROUP_ROLES) {
          expect(canChangeRole(actorRole, targetRole, nextRole, false)).toBe(false);
        }
      }
    }
  });

  it('never allows assigning OWNER or changing your own role', () => {
    for (const targetRole of GROUP_ROLES) {
      expect(canChangeRole('OWNER', targetRole, 'OWNER', false)).toBe(false);
      expect(canChangeRole('OWNER', targetRole, 'ADMIN', true)).toBe(false);
      expect(canChangeRole('OWNER', targetRole, 'MEMBER', true)).toBe(false);
    }
  });
});
