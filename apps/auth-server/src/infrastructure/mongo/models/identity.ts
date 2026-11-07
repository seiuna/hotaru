import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { SCOPES } from '@hotaru/shared-types';

const userSchema = new Schema(
  {
    /** Primary Minecraft UUID, kept for the existing admin surface. Null for account-only rows. */
    minecraftUuid: { type: String },
    /** Platform login name. Null until the account is activated or claimed. */
    loginName: { type: String },
    /** scrypt hash; null means this account cannot use password login. */
    passwordHash: { type: String, default: null },
    email: { type: String, default: null },
    twoFactorSecret: { type: String, default: null },
    twoFactorEnabledAt: { type: Date, default: null },
    /** Display name. Legacy rows use the Minecraft name; accounts use their login name. */
    username: { type: String, required: true },
    status: { type: String, enum: ['active', 'banned'], default: 'active', index: true },
    banReason: { type: String, default: null },
    bannedAt: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'users' },
);
userSchema.index(
  { email: 1 },
  {
    unique: true,
    name: 'email_unique',
    partialFilterExpression: { email: { $type: 'string' } },
  },
);
userSchema.index({ username: 1 });
userSchema.index(
  { minecraftUuid: 1 },
  {
    unique: true,
    name: 'minecraftUuid_unique',
    partialFilterExpression: { minecraftUuid: { $type: 'string' } },
  },
);
userSchema.index(
  { loginName: 1 },
  {
    unique: true,
    name: 'loginName_unique',
    partialFilterExpression: { loginName: { $type: 'string' } },
  },
);

const minecraftLinkSchema = new Schema(
  {
    accountId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    minecraftUuid: { type: String, required: true, unique: true, index: true },
    minecraftUsername: { type: String, required: true },
    status: { type: String, enum: ['active', 'banned'], default: 'active', index: true },
    verifiedAt: { type: Date, required: true },
    linkedAt: { type: Date, required: true },
    banReason: { type: String, default: null },
    bannedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'minecraft_links' },
);
minecraftLinkSchema.index({ accountId: 1, status: 1 });

const minecraftBindingCodeSchema = new Schema(
  {
    codeHash: { type: String, required: true, unique: true, index: true },
    minecraftUuid: { type: String, required: true, index: true },
    minecraftUsername: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: true },
    usedAt: { type: Date, default: null, index: true },
    usedByAccountId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, collection: 'minecraft_binding_codes' },
);

const activationCodeUseSchema = new Schema(
  {
    jti: { type: String, required: true, unique: true, index: true },
    type: { type: String, enum: ['account', 'bind', 'claim'], required: true, index: true },
    accountId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    minecraftUuid: { type: String, default: null, index: true },
    usedAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'activation_code_uses' },
);

const passwordResetTokenSchema = new Schema(
  {
    accountId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true, index: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'password_reset_tokens' },
);
passwordResetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type UserDoc = InferSchemaType<typeof userSchema>;
export const UserModel: Model<UserDoc> =
  (model<UserDoc>('User', userSchema) as Model<UserDoc>);
export type MinecraftLinkDoc = InferSchemaType<typeof minecraftLinkSchema>;
export const MinecraftLinkModel: Model<MinecraftLinkDoc> = model<MinecraftLinkDoc>(
  'MinecraftLink',
  minecraftLinkSchema,
);
export type MinecraftBindingCodeDoc = InferSchemaType<typeof minecraftBindingCodeSchema>;
export const MinecraftBindingCodeModel: Model<MinecraftBindingCodeDoc> =
  model<MinecraftBindingCodeDoc>('MinecraftBindingCode', minecraftBindingCodeSchema);
export type ActivationCodeUseDoc = InferSchemaType<typeof activationCodeUseSchema>;
export const ActivationCodeUseModel: Model<ActivationCodeUseDoc> = model<ActivationCodeUseDoc>(
  'ActivationCodeUse',
  activationCodeUseSchema,
);
export type PasswordResetTokenDoc = InferSchemaType<typeof passwordResetTokenSchema>;
export const PasswordResetTokenModel: Model<PasswordResetTokenDoc> =
  model<PasswordResetTokenDoc>('PasswordResetToken', passwordResetTokenSchema);

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
