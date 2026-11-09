import { Schema, model, type InferSchemaType, type Model } from 'mongoose';

const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** Distinguishes a game session from a user-portal session. */
    kind: { type: String, enum: ['mc', 'portal'], default: 'mc', index: true },
    /** Minecraft UUID used for an MC session; null for a portal session. */
    minecraftUuid: { type: String, default: null, index: true },
    /** Client identity attached to the challenge (never trusted for authz). */
    clientId: { type: String, default: null, index: true },
    clientVersion: { type: String, default: null },
    clientKeyId: { type: String, default: null },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
  },
  { timestamps: true, collection: 'sessions' },
);
sessionSchema.index({ userId: 1, expiresAt: -1 });
sessionSchema.index({ minecraftUuid: 1, expiresAt: -1 });
// No TTL here on purpose: revocation must stay checkable for the whole token
// lifetime, and MongoDB TTL deletion is not immediate.

export type SessionDoc = InferSchemaType<typeof sessionSchema>;
export const SessionModel: Model<SessionDoc> = model<SessionDoc>('Session', sessionSchema);

const refreshTokenSchema = new Schema(
  {
    sessionId: { type: Schema.Types.ObjectId, ref: 'Session', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** SHA-256 of the opaque token. The raw token is never stored. */
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    replacedByHash: { type: String, default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'refresh_tokens' },
);
// TTL cleanup is a convenience, not a security control: expiry is always
// re-checked in code because TTL deletion lags by up to ~60s.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type RefreshTokenDoc = InferSchemaType<typeof refreshTokenSchema>;
export const RefreshTokenModel: Model<RefreshTokenDoc> = model<RefreshTokenDoc>(
  'RefreshToken',
  refreshTokenSchema,
);
