import mongoose, { type Model } from 'mongoose';
import type { GroupRole, GroupVisibility } from '../../runtime/contracts.js';

/**
 * Storage for groups and memberships (design §11.2 / §11.3).
 *
 * Two collections, not one embedded document: membership is queried from both
 * directions (`listGroupsForUser` by user, `memberUuids` by group), and a
 * 100-member array inside the group document would make every role check read
 * and rewrite the whole array.
 *
 * Groups are soft-deleted (`status: DELETED`) so an id is never recycled and the
 * audit trail keeps pointing at a real document; memberships are removed, because
 * a deleted group must not authorise a message. Every query that resolves a group
 * for a decision also filters on `status: 'ACTIVE'`, so a leaked soft-deleted
 * document can never be used.
 *
 * Note the default `mongoose` import: mongoose is CJS, and `models` is not one of
 * the statically detectable named exports, so `import { models } from 'mongoose'`
 * type-checks but throws at runtime in ESM.
 */

export interface IrcGroupDoc {
  /** Public opaque id (`grp_…`), never the ObjectId. */
  groupId: string;
  name: string;
  /** Canonical dashed lowercase Mojang UUID. */
  ownerUuid: string;
  visibility: GroupVisibility;
  maxMembers: number;
  status: 'ACTIVE' | 'DELETED';
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const groupSchema = new mongoose.Schema<IrcGroupDoc>(
  {
    groupId: { type: String, required: true },
    name: { type: String, required: true },
    ownerUuid: { type: String, required: true },
    visibility: { type: String, enum: ['PRIVATE', 'PUBLIC'], default: 'PRIVATE', required: true },
    maxMembers: { type: Number, required: true },
    status: { type: String, enum: ['ACTIVE', 'DELETED'], default: 'ACTIVE', required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'irc_groups', versionKey: false },
);

groupSchema.index({ groupId: 1 }, { unique: true });
// "groups I own" and "browse public groups" both start from owner/status.
groupSchema.index({ ownerUuid: 1, status: 1 });
groupSchema.index({ status: 1, visibility: 1, updatedAt: -1 });

export const IrcGroupModel: Model<IrcGroupDoc> =
  (mongoose.models['IrcGroup'] as Model<IrcGroupDoc> | undefined) ??
  mongoose.model<IrcGroupDoc>('IrcGroup', groupSchema);

export interface IrcGroupMemberDoc {
  groupId: string;
  /** Canonical dashed lowercase Mojang UUID. */
  userUuid: string;
  role: GroupRole;
  joinedAt: Date;
}

const groupMemberSchema = new mongoose.Schema<IrcGroupMemberDoc>(
  {
    groupId: { type: String, required: true },
    userUuid: { type: String, required: true },
    role: { type: String, enum: ['OWNER', 'ADMIN', 'MEMBER'], required: true },
  },
  {
    // `joinedAt` is the creation timestamp; memberships are never "updated".
    timestamps: { createdAt: 'joinedAt', updatedAt: false },
    collection: 'irc_group_members',
    versionKey: false,
  },
);

// One membership per (group, user): the unique key is also the idempotency guard
// for concurrent invites.
groupMemberSchema.index({ groupId: 1, userUuid: 1 }, { unique: true });
// Fan-out path: every GROUP message resolves the member list by group id.
groupMemberSchema.index({ userUuid: 1, groupId: 1 });

export const IrcGroupMemberModel: Model<IrcGroupMemberDoc> =
  (mongoose.models['IrcGroupMember'] as Model<IrcGroupMemberDoc> | undefined) ??
  mongoose.model<IrcGroupMemberDoc>('IrcGroupMember', groupMemberSchema);
