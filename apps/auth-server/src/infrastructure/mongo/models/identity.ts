import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { SCOPES } from '@hotaru/shared-types';

const userSchema = new Schema(
  {
    /** Canonical dashed lowercase Mojang UUID. The only identity that matters. */
    minecraftUuid: { type: String, required: true, unique: true, index: true },
    /** Display only: Minecraft players can rename, so this is never a key. */
    username: { type: String, required: true },
    status: { type: String, enum: ['active', 'banned'], default: 'active', index: true },
    banReason: { type: String, default: null },
    bannedAt: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'users' },
);
userSchema.index({ username: 1 });

export type UserDoc = InferSchemaType<typeof userSchema>;
export const UserModel: Model<UserDoc> =
  (model<UserDoc>('User', userSchema) as Model<UserDoc>);

const permissionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    scope: { type: String, enum: SCOPES, required: true },
    /** null = permanent grant. */
    expiresAt: { type: Date, default: null },
    grantedBy: { type: String, default: null },
  },
  { timestamps: true, collection: 'permissions' },
);
permissionSchema.index({ userId: 1, scope: 1 }, { unique: true });
// Expiry is enforced in queries (expired grants are filtered out), never by a
// TTL index: deleting a grant silently is harder to audit than ignoring it.
permissionSchema.index({ userId: 1, expiresAt: 1 });

export type PermissionDoc = InferSchemaType<typeof permissionSchema>;
export const PermissionModel: Model<PermissionDoc> = model<PermissionDoc>(
  'Permission',
  permissionSchema,
);

const adminSchema = new Schema(
  {
    /** Minecraft UUID of the administrator (lowercase dashed). */
    identity: { type: String, required: true, unique: true },
    role: { type: String, enum: ['owner', 'admin', 'support'], default: 'admin' },
    createdBy: { type: String, default: null },
  },
  { timestamps: true, collection: 'admins' },
);

export type AdminDoc = InferSchemaType<typeof adminSchema>;
export const AdminModel: Model<AdminDoc> = model<AdminDoc>('Admin', adminSchema);
