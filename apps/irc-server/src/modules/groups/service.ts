import type { HydratedDocument } from 'mongoose';
import type { AppContext } from '../../context.js';
import { AppError } from '../../http/app-error.js';
import type {
  GroupMembership,
  GroupRole,
  GroupService,
  GroupSummary,
  GroupVisibility,
} from '../../runtime/contracts.js';
import { canonicalUuidOrNull, newGroupId, toCanonicalUuid } from './ids.js';
import { IrcGroupMemberModel, IrcGroupModel, type IrcGroupDoc, type IrcGroupMemberDoc } from './model.js';
import { canAssignRole, canChangeRole, canRemoveMember, permissionsFor } from './roles.js';

/** Name rules are enforced here, not only in the route schema: the service is the contract. */
const GROUP_NAME_MAX_LENGTH = 64;
const MIN_GROUP_MEMBERS = 2;

type GroupDocument = HydratedDocument<IrcGroupDoc>;
type MemberDocument = HydratedDocument<IrcGroupMemberDoc>;
type GroupProjection = Pick<
  IrcGroupDoc,
  'groupId' | 'name' | 'ownerUuid' | 'visibility' | 'maxMembers' | 'createdAt' | 'updatedAt'
>;
type MembershipProjection = Pick<IrcGroupMemberDoc, 'groupId' | 'userUuid' | 'role' | 'joinedAt'>;

const groupNotFound = (): AppError => new AppError('GROUP_NOT_FOUND', 'Group not found');
const groupAccessDenied = (): AppError => new AppError('GROUP_ACCESS_DENIED', 'No access to this group');
const invalidRequest = (message: string): AppError => new AppError('INVALID_REQUEST', message);
const forbidden = (message: string): AppError => new AppError('FORBIDDEN', message);

function toIso(value: Date | null | undefined): string {
  return value instanceof Date ? value.toISOString() : new Date(0).toISOString();
}

function toSummary(group: GroupProjection): GroupSummary {
  return {
    id: group.groupId,
    name: group.name,
    ownerUuid: group.ownerUuid,
    visibility: group.visibility,
    maxMembers: group.maxMembers,
    status: 'ACTIVE',
    createdAt: toIso(group.createdAt),
    updatedAt: toIso(group.updatedAt),
  };
}

function toMembership(member: MembershipProjection): GroupMembership {
  return {
    groupId: member.groupId,
    userUuid: member.userUuid,
    role: member.role,
    joinedAt: toIso(member.joinedAt),
  };
}

/** True when the string contains a C0 control character or DEL. */
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Trim + collapse whitespace; the name is display text, not an identifier. */
function normalizeGroupName(raw: string): string {
  if (typeof raw !== 'string') throw invalidRequest('name must be a string');
  const collapsed = raw.trim().replace(/\s+/g, ' ');
  if (collapsed.length === 0) throw invalidRequest('name must not be empty');
  if (collapsed.length > GROUP_NAME_MAX_LENGTH) {
    throw invalidRequest(`name must be at most ${GROUP_NAME_MAX_LENGTH} characters`);
  }
  if (hasControlCharacters(collapsed)) {
    throw invalidRequest('name must not contain control characters');
  }
  return collapsed;
}

/** Per-group cap: never above the server-wide limit, never below two members. */
function resolveMaxMembers(requested: number | undefined, configMax: number): number {
  if (requested === undefined) return configMax;
  if (!Number.isInteger(requested) || requested < MIN_GROUP_MEMBERS) {
    throw invalidRequest(`maxMembers must be an integer of at least ${MIN_GROUP_MEMBERS}`);
  }
  if (requested > configMax) throw invalidRequest(`maxMembers must not exceed ${configMax}`);
  return requested;
}

/** An identity we already trust (JWT claim). */
function requireActor(raw: string): string {
  const actor = typeof raw === 'string' ? toCanonicalUuid(raw) : '';
  if (actor.length === 0) {
    throw new AppError('UNAUTHORIZED', 'Authenticated user is missing a Minecraft UUID');
  }
  return actor;
}

/** A member UUID supplied by a client: reject typos instead of storing junk. */
function requireTargetUuid(raw: string, field: string): string {
  const uuid = typeof raw === 'string' ? canonicalUuidOrNull(raw) : null;
  if (!uuid) throw invalidRequest(`${field} must be a Minecraft UUID`);
  return uuid;
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
}

/**
 * Groups + memberships (design §9.2 / §11.2 / §11.3), backed by MongoDB.
 *
 * Contract-specific behaviour worth stating once:
 *
 * - **No existence oracle.** `getGroup` answers GROUP_NOT_FOUND to *any*
 *   non-member, public or private. Reads never reveal a group to someone who is
 *   not in it; write endpoints may answer GROUP_ACCESS_DENIED because the caller
 *   has already proven they know an id they cannot use.
 * - **Idempotent invite.** Adding an existing member returns their current
 *   membership and never changes their role — a retried request cannot silently
 *   promote anyone. Concurrent invites race on the unique (groupId, userUuid)
 *   index; the loser re-reads the winner's row.
 * - **Capacity is the lower of the group cap and `config.maxGroupMembers`.**
 *   Lowering the config therefore cannot be bypassed by an older group.
 * - **Duplicate names are allowed** (a name is display text, not a key); the
 *   opaque id is the identity.
 */
export function createGroupService(ctx: AppContext): GroupService {
  const configMaxMembers = ctx.config.maxGroupMembers;

  async function loadActiveGroup(groupId: string): Promise<GroupDocument> {
    const id = typeof groupId === 'string' ? groupId.trim() : '';
    if (id.length === 0) throw groupNotFound();
    const group = await IrcGroupModel.findOne({ groupId: id, status: 'ACTIVE' }).exec();
    if (!group) throw groupNotFound();
    return group;
  }

  async function loadMembership(groupId: string, userUuid: string): Promise<MemberDocument | null> {
    return IrcGroupMemberModel.findOne({ groupId, userUuid }).exec();
  }

  async function requireMembership(groupId: string, actorRaw: string): Promise<MemberDocument> {
    const member = await loadMembership(groupId, requireActor(actorRaw));
    if (!member) throw groupAccessDenied();
    return member;
  }

  return {
    async createGroup(input) {
      const ownerUuid = requireActor(input.ownerUuid);
      const name = normalizeGroupName(input.name);
      const maxMembers = resolveMaxMembers(input.maxMembers, configMaxMembers);
      const groupId = newGroupId();

      const group = await IrcGroupModel.create({
        groupId,
        name,
        ownerUuid,
        visibility: 'PRIVATE',
        maxMembers,
        status: 'ACTIVE',
        deletedAt: null,
      });

      try {
        await IrcGroupMemberModel.create({ groupId, userUuid: ownerUuid, role: 'OWNER' });
      } catch (error) {
        // A group without its owner is unusable; do not leave the orphan behind.
        await IrcGroupModel.deleteOne({ groupId }).exec().catch(() => undefined);
        throw error;
      }

      return toSummary(group);
    },

    async listGroupsForUser(userUuid) {
      const actor = requireActor(userUuid);
      const memberships = await IrcGroupMemberModel.find({ userUuid: actor })
        .select('groupId')
        .lean<Array<Pick<IrcGroupMemberDoc, 'groupId'>>>()
        .exec();
      if (memberships.length === 0) return [];

      const groupIds = memberships.map((membership) => membership.groupId);
      const groups = await IrcGroupModel.find({ groupId: { $in: groupIds }, status: 'ACTIVE' })
        .sort({ createdAt: 1, groupId: 1 })
        .lean<GroupProjection[]>()
        .exec();
      return groups.map(toSummary);
    },

    async getGroup(groupId, viewerUuid) {
      const group = await loadActiveGroup(groupId);
      const member = await loadMembership(group.groupId, requireActor(viewerUuid));
      // Same answer for "does not exist" and "not yours" (see the doc comment).
      if (!member) throw groupNotFound();
      return toSummary(group);
    },

    async updateGroup(groupId, actorUuid, patch) {
      const group = await loadActiveGroup(groupId);
      const member = await requireMembership(group.groupId, actorUuid);
      if (!permissionsFor(member.role).canEditGroup) {
        throw forbidden('Only group owners and admins may edit a group');
      }

      const set: Record<string, unknown> = {};
      let changed = false;

      if (patch.name !== undefined) {
        set['name'] = normalizeGroupName(patch.name);
        changed = true;
      }
      if (patch.visibility !== undefined) {
        const visibility: GroupVisibility = patch.visibility;
        if (visibility !== 'PRIVATE' && visibility !== 'PUBLIC') {
          throw invalidRequest('visibility must be PRIVATE or PUBLIC');
        }
        set['visibility'] = visibility;
        changed = true;
      }
      if (patch.maxMembers !== undefined) {
        const nextMax = resolveMaxMembers(patch.maxMembers, configMaxMembers);
        const memberCount = await IrcGroupMemberModel.countDocuments({ groupId: group.groupId }).exec();
        if (nextMax < memberCount) {
          throw invalidRequest(
            `maxMembers cannot be lower than the current member count (${memberCount})`,
          );
        }
        set['maxMembers'] = nextMax;
        changed = true;
      }

      if (!changed) throw invalidRequest('At least one of name, visibility or maxMembers is required');

      set['updatedAt'] = new Date(ctx.now());
      const updated = await IrcGroupModel.findOneAndUpdate(
        { groupId: group.groupId, status: 'ACTIVE' },
        { $set: set },
        { new: true },
      ).exec();
      if (!updated) throw groupNotFound();
      return toSummary(updated);
    },

    async deleteGroup(groupId, actorUuid) {
      const group = await loadActiveGroup(groupId);
      const member = await requireMembership(group.groupId, actorUuid);
      if (!permissionsFor(member.role).canDeleteGroup) {
        throw forbidden('Only the group owner may delete a group');
      }

      const now = new Date(ctx.now());
      // Soft-delete the group, hard-delete the memberships: a deleted group must
      // never authorise a message, and the id must never be reused.
      await IrcGroupModel.updateOne(
        { groupId: group.groupId, status: 'ACTIVE' },
        { $set: { status: 'DELETED', deletedAt: now, updatedAt: now } },
      ).exec();
      await IrcGroupMemberModel.deleteMany({ groupId: group.groupId }).exec();
    },

    async addMember(groupId, actorUuid, targetUuid, role) {
      const group = await loadActiveGroup(groupId);
      const actor = await requireMembership(group.groupId, actorUuid);

      const requestedRole: GroupRole = role ?? 'MEMBER';
      if (!canAssignRole(actor.role, requestedRole)) {
        throw forbidden(
          requestedRole === 'ADMIN'
            ? 'Only the group owner may add an admin'
            : 'Only group owners and admins may add members',
        );
      }

      const target = requireTargetUuid(targetUuid, 'userUuid');

      const existing = await loadMembership(group.groupId, target);
      if (existing) return toMembership(existing);

      const capacity = Math.min(group.maxMembers, configMaxMembers);
      const memberCount = await IrcGroupMemberModel.countDocuments({ groupId: group.groupId }).exec();
      if (memberCount >= capacity) {
        throw new AppError('CONFLICT', `Group is full (${capacity} members)`);
      }

      try {
        const created = await IrcGroupMemberModel.create({
          groupId: group.groupId,
          userUuid: target,
          role: requestedRole,
        });
        return toMembership(created);
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          const raced = await loadMembership(group.groupId, target);
          if (raced) return toMembership(raced);
        }
        throw error;
      }
    },

    async removeMember(groupId, actorUuid, targetUuid) {
      const group = await loadActiveGroup(groupId);
      const actor = await requireMembership(group.groupId, actorUuid);
      const target = requireTargetUuid(targetUuid, 'userUuid');

      const targetMember = await loadMembership(group.groupId, target);
      if (!targetMember) throw new AppError('NOT_FOUND', 'Member not found');

      const isSelf = target === requireActor(actorUuid);
      if (!canRemoveMember(actor.role, targetMember.role, isSelf)) {
        throw forbidden(
          isSelf
            ? 'The group owner cannot leave: delete the group instead'
            : 'You may not remove this member',
        );
      }

      await IrcGroupMemberModel.deleteOne({ _id: targetMember._id }).exec();
    },

    async setMemberRole(groupId, actorUuid, targetUuid, role) {
      const group = await loadActiveGroup(groupId);
      const actor = await requireMembership(group.groupId, actorUuid);

      if (role === 'OWNER') {
        // v1 has no ownership transfer; accepting it would mean either two owners
        // or an ownerless group. Delete + recreate is the documented alternative.
        throw invalidRequest('Ownership transfer is not supported; the group owner cannot change');
      }

      const target = requireTargetUuid(targetUuid, 'userUuid');
      const targetMember = await loadMembership(group.groupId, target);
      if (!targetMember) throw new AppError('NOT_FOUND', 'Member not found');

      const isSelf = target === requireActor(actorUuid);
      if (!canChangeRole(actor.role, targetMember.role, role, isSelf)) {
        throw forbidden(
          isSelf ? 'You cannot change your own role' : 'Only the group owner may change member roles',
        );
      }

      if (targetMember.role === role) return toMembership(targetMember);

      targetMember.role = role;
      await targetMember.save();
      return toMembership(targetMember);
    },

    async membership(groupId, userUuid) {
      const id = typeof groupId === 'string' ? groupId.trim() : '';
      const user = typeof userUuid === 'string' ? toCanonicalUuid(userUuid) : '';
      if (id.length === 0 || user.length === 0) return null;

      const member = await IrcGroupMemberModel.findOne({ groupId: id, userUuid: user })
        .select('groupId userUuid role joinedAt')
        .lean<MembershipProjection>()
        .exec();
      return member ? toMembership(member) : null;
    },

    async memberUuids(groupId) {
      const id = typeof groupId === 'string' ? groupId.trim() : '';
      if (id.length === 0) return [];

      const members = await IrcGroupMemberModel.find({ groupId: id })
        .sort({ joinedAt: 1, userUuid: 1 })
        .select('userUuid')
        .lean<Array<Pick<IrcGroupMemberDoc, 'userUuid'>>>()
        .exec();
      return members.map((member) => member.userUuid);
    },
  };
}
