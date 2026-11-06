import { Schema, model, type InferSchemaType, type Model } from 'mongoose';

const auditLogSchema = new Schema(
  {
    event: { type: String, required: true, index: true },
    actorId: { type: Schema.Types.ObjectId, default: null, index: true },
    actorType: { type: String, enum: ['user', 'admin', 'system'], default: 'system' },
    targetType: { type: String, default: null },
    targetId: { type: String, default: null },
    ip: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'audit_logs' },
);
auditLogSchema.index({ createdAt: -1 });
// Retention window for security logs (TTL deletion is eventually consistent).
auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 180 });

export type AuditLogDoc = InferSchemaType<typeof auditLogSchema>;
export const AuditLogModel: Model<AuditLogDoc> = model<AuditLogDoc>('AuditLog', auditLogSchema);

const licenseSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    product: { type: String, required: true },
    status: { type: String, enum: ['active', 'expired', 'revoked'], default: 'active' },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'licenses' },
);
licenseSchema.index({ userId: 1, product: 1 }, { unique: true });

export type LicenseDoc = InferSchemaType<typeof licenseSchema>;
export const LicenseModel: Model<LicenseDoc> = model<LicenseDoc>('License', licenseSchema);

/**
 * Long-lived cryptographic material. Env PEMs win when present; otherwise the
 * service generates a pair once and persists it here so restarts keep the same
 * JWKS and Minecraft public key. Production should inject PEMs from a KMS.
 */
const serviceKeySchema = new Schema(
  {
    purpose: { type: String, required: true, unique: true },
    alg: { type: String, required: true },
    kid: { type: String, required: true },
    privatePem: { type: String, required: true },
    publicPem: { type: String, required: true },
  },
  { timestamps: true, collection: 'service_keys' },
);

export type ServiceKeyDoc = InferSchemaType<typeof serviceKeySchema>;
export const ServiceKeyModel: Model<ServiceKeyDoc> = model<ServiceKeyDoc>(
  'ServiceKey',
  serviceKeySchema,
);
