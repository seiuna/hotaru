import {
  IRC_RESERVED_TAGS,
  IRC_TAGS,
  IRC_TAG_KEYS,
  profileTags,
  type IrcTagKey,
  type PlayerProfile,
} from '@hotaru/srp-protocol';
import { Errors } from '../../http/app-error.js';
import { IrcPlayerProfileModel } from './model.js';

const NICKNAME_PATTERN = /^[\p{L}\p{N}_.-]{3,24}$/u;
const RESERVED_NICKNAMES = new Set(['admin', 'system', 'server', 'hotaru']);

export function validateNickname(raw: string): string {
  const nickname = raw.trim();
  if (!NICKNAME_PATTERN.test(nickname)) {
    throw Errors.invalid('nickname must be 3-24 letters, numbers, Chinese characters, dot, underscore or hyphen');
  }
  if (/^\d+$/.test(nickname)) throw Errors.invalid('nickname cannot be all digits');
  if (RESERVED_NICKNAMES.has(nickname.toLowerCase())) {
    throw Errors.invalid('nickname is reserved');
  }
  return nickname;
}

export function normalizeManualTags(raw: readonly string[]): IrcTagKey[] {
  const tags = [...new Set(raw)];
  for (const tag of tags) {
    if (!IRC_TAG_KEYS.includes(tag as IrcTagKey)) {
      throw Errors.invalid(`unknown tag: ${tag}`);
    }
    if (IRC_RESERVED_TAGS.includes(tag as IrcTagKey)) {
      throw Errors.invalid(`tag is derived from permissions and cannot be set manually: ${tag}`);
    }
  }
  if (tags.length > 3) throw Errors.invalid('at most 3 manual tags are allowed');
  return tags.sort((a, b) => IRC_TAGS[b as IrcTagKey].priority - IRC_TAGS[a as IrcTagKey].priority) as IrcTagKey[];
}

export async function getPlayerProfile(
  minecraftUuid: string,
  username: string,
  scopes: readonly string[],
): Promise<PlayerProfile> {
  const profile = await IrcPlayerProfileModel.findOne({ minecraftUuid }).lean();
  return {
    nickname: profile?.nickname ?? username,
    tags: profileTags(scopes, profile?.manualTags ?? []),
  };
}

export async function getStoredProfile(
  minecraftUuid: string,
): Promise<{ nickname: string | null; manualTags: IrcTagKey[] }> {
  const profile = await IrcPlayerProfileModel.findOne({ minecraftUuid }).lean();
  return {
    nickname: profile?.nickname ?? null,
    manualTags: (profile?.manualTags ?? []) as IrcTagKey[],
  };
}

export async function setOwnNickname(
  minecraftUuid: string,
  username: string,
  nickname: string,
  scopes: readonly string[],
): Promise<PlayerProfile> {
  const display = validateNickname(nickname);
  const nicknameLower = display.toLowerCase();
  try {
    await IrcPlayerProfileModel.updateOne(
      { minecraftUuid },
      { $set: { nickname: display, nicknameLower } },
      { upsert: true },
    );
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
      throw Errors.conflict('nickname is already in use');
    }
    throw error;
  }
  return getPlayerProfile(minecraftUuid, username, scopes);
}

export async function setAdminProfile(
  minecraftUuid: string,
  username: string,
  input: { nickname?: string; tags?: string[] },
  scopes: readonly string[],
): Promise<PlayerProfile> {
  const patch: Record<string, unknown> = {};
  if (input.nickname !== undefined) {
    const display = validateNickname(input.nickname);
    patch.nickname = display;
    patch.nicknameLower = display.toLowerCase();
  }
  if (input.tags !== undefined) {
    patch.manualTags = normalizeManualTags(input.tags);
  }
  if (Object.keys(patch).length === 0) throw Errors.invalid('nickname or tags is required');
  try {
    await IrcPlayerProfileModel.updateOne({ minecraftUuid }, { $set: patch }, { upsert: true });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
      throw Errors.conflict('nickname is already in use');
    }
    throw error;
  }
  return getPlayerProfile(minecraftUuid, username, scopes);
}
