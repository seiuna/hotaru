import {
  ActivationCodeUseModel,
  AdminModel,
  AuditLogModel,
  LicenseModel,
  MinecraftBindingCodeModel,
  MinecraftLinkModel,
  PermissionModel,
  RefreshTokenModel,
  ServiceKeyModel,
  SessionModel,
  UserModel,
} from './models/index.js';

const models = [
  UserModel,
  PermissionModel,
  AdminModel,
  SessionModel,
  RefreshTokenModel,
  AuditLogModel,
  LicenseModel,
  ServiceKeyModel,
  MinecraftLinkModel,
  MinecraftBindingCodeModel,
  ActivationCodeUseModel,
];

/**
 * Creates the declared indexes if they are missing.
 *
 * `createIndexes()` is additive: it never drops an index that exists in the
 * database but not in the schema, so running it on every boot cannot destroy an
 * operator's manual index. Mongoose's `autoIndex` is disabled in production to
 * keep boot predictable, which is why a brand-new production database needs
 * this explicit step: unique constraints on `users.minecraftUuid`,
 * `permissions(userId, scope)` and `refresh_tokens.tokenHash` are correctness
 * requirements, not optimisations.
 */
export async function ensureIndexes(): Promise<void> {
  for (const model of models) {
    await model.createIndexes();
  }
}
