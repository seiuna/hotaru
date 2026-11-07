import { createHash, randomBytes } from 'node:crypto';
import type { AppContext } from '../../context.js';
import { Errors } from '../../errors.js';
import { MinecraftBindingCodeModel } from '../../infrastructure/mongo/models/index.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomPart(length: number): string {
  const bytes = randomBytes(length);
  let value = '';
  for (let index = 0; index < length; index += 1) {
    const byte = bytes[index] ?? 0;
    value += ALPHABET[byte % ALPHABET.length] ?? '';
  }
  return value;
}

export function hashBindingCode(code: string): string {
  return createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
}

/** Human-typable one-time code. The plaintext is returned exactly once. */
export function newBindingCode(): string {
  return `HOTARU-${randomPart(4)}-${randomPart(4)}`;
}

export async function issueBindingCode(
  ctx: AppContext,
  profile: { uuid: string; username: string },
): Promise<{ code: string; expiresIn: number }> {
  const code = newBindingCode();
  const expiresAt = new Date(Date.now() + ctx.config.bindingCodeTtlSeconds * 1000);
  await MinecraftBindingCodeModel.create({
    codeHash: hashBindingCode(code),
    minecraftUuid: profile.uuid,
    minecraftUsername: profile.username,
    expiresAt,
  });
  return { code, expiresIn: ctx.config.bindingCodeTtlSeconds };
}

export interface ConsumedBindingCode {
  minecraftUuid: string;
  minecraftUsername: string;
}

/**
 * Atomically consumes a code. A missing code and a used/expired code are
 * distinct errors so the portal can tell the user whether to request a new one.
 */
export async function consumeBindingCode(
  code: string,
  accountId: string,
): Promise<ConsumedBindingCode> {
  const codeHash = hashBindingCode(code);
  const existing = await MinecraftBindingCodeModel.findOne({ codeHash }).lean();
  if (!existing) throw Errors.linkCodeInvalid();
  if (existing.usedAt) throw Errors.linkCodeInvalid();
  if (existing.expiresAt.getTime() <= Date.now()) throw Errors.linkCodeExpired();

  const consumed = await MinecraftBindingCodeModel.findOneAndUpdate(
    { codeHash, usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date(), usedByAccountId: accountId } },
    { new: true },
  ).lean();
  if (!consumed) throw Errors.linkCodeInvalid();
  return {
    minecraftUuid: consumed.minecraftUuid,
    minecraftUsername: consumed.minecraftUsername,
  };
}
