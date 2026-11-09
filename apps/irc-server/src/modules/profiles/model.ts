import mongoose, { type Model } from 'mongoose';

export interface IrcPlayerProfileDoc {
  minecraftUuid: string;
  /** Custom display name; null means "use the Minecraft username". */
  nickname: string | null;
  nicknameLower: string | null;
  manualTags: string[];
  updatedAt: Date;
}

const profileSchema = new mongoose.Schema<IrcPlayerProfileDoc>(
  {
    minecraftUuid: { type: String, required: true },
    nickname: { type: String, default: null },
    nicknameLower: { type: String, default: null },
    manualTags: { type: [String], default: [] },
  },
  { timestamps: true, collection: 'irc_player_profiles', versionKey: false },
);

profileSchema.index({ minecraftUuid: 1 }, { unique: true });
profileSchema.index(
  { nicknameLower: 1 },
  {
    unique: true,
    partialFilterExpression: { nicknameLower: { $type: 'string' } },
    name: 'nickname_lower_unique',
  },
);

export const IrcPlayerProfileModel: Model<IrcPlayerProfileDoc> =
  (mongoose.models['IrcPlayerProfile'] as Model<IrcPlayerProfileDoc> | undefined) ??
  mongoose.model<IrcPlayerProfileDoc>('IrcPlayerProfile', profileSchema);
