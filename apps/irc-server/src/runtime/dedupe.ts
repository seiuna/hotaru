import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { dedupeKey } from '@skymatrix/srp-protocol';

export interface DedupeResult {
  status: 'new' | 'duplicate-same' | 'duplicate-different';
  previous?: { fingerprint: string };
}

/**
 * Short-window replay protection, keyed by sender + message id (never the id
 * alone). The stored value is a hash of the payload plus the recorded outcome,
 * so a retry with an identical body can be answered with the previous result
 * while a *different* body under the same id is refused.
 */
export class DedupeStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlMs: number,
  ) {}

  static fingerprint(payload: unknown): string {
    return createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex').slice(0, 32);
  }

  consumerKey(senderUserId: string, messageId: string): string {
    return dedupeKey(senderUserId, messageId);
  }

  async begin(senderUserId: string, messageId: string, payload: unknown): Promise<DedupeResult> {
    const key = this.consumerKey(senderUserId, messageId);
    const fingerprint = DedupeStore.fingerprint(payload);
    const value = JSON.stringify({ fingerprint, at: Date.now() });

    const inserted = await this.redis.set(key, value, 'PX', this.ttlMs, 'NX');
    if (inserted === 'OK') return { status: 'new' };

    const existing = await this.redis.get(key);
    if (!existing) {
      // Expired between SET NX and GET: treat as new rather than failing the send.
      const retried = await this.redis.set(key, value, 'PX', this.ttlMs, 'NX');
      return retried === 'OK' ? { status: 'new' } : { status: 'duplicate-different' };
    }

    try {
      const parsed = JSON.parse(existing) as { fingerprint?: string };
      if (parsed.fingerprint === fingerprint) {
        return {
          status: 'duplicate-same',
          previous: { fingerprint: parsed.fingerprint },
        };
      }
    } catch {
      // Corrupt entry: treat as different so we never silently re-send.
    }
    return { status: 'duplicate-different' };
  }
}
