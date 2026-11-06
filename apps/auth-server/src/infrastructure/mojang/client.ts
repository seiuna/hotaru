import type { AppConfig } from '../../config/env.js';
import { Errors } from '../../errors.js';

export interface MojangSessionProfile {
  /** Canonical dashed lowercase UUID. */
  uuid: string;
  username: string;
}

export interface HasJoinedInput {
  username: string;
  /** Minecraft server hash (signed hex) — the same value the client sent to join. */
  serverId: string;
  ip?: string;
}

/** Mojang returns undashed ids; every internal UUID is dashed lowercase. */
export function normalizeUuid(raw: string): string {
  const hex = raw.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error(`Mojang returned a malformed UUID: ${raw}`);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

interface MojangHasJoinedRaw {
  id: string;
  name: string;
  properties?: Array<{ name: string; value: string }>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Calls Mojang `hasJoined`. Returns null when Mojang answers "no such session"
 * (204 / 4xx) — that is a *negative verification*, never a pass. Throws
 * MOJANG_UNAVAILABLE on transport errors, timeouts and 5xx so the caller can
 * fail closed with a retryable error.
 *
 * A short retry window exists because the client's `join` call and our
 * `hasJoined` call are independent requests to Mojang; a first 204 right after
 * join is usually propagation delay, not a forged session.
 */
export async function hasJoined(
  config: AppConfig,
  input: HasJoinedInput,
): Promise<MojangSessionProfile | null> {
  const url = new URL('/session/minecraft/hasJoined', config.mojangSessionServer);
  url.searchParams.set('username', input.username);
  url.searchParams.set('serverId', input.serverId);
  if (input.ip) url.searchParams.set('ip', input.ip);

  const attempts = Math.max(1, config.mojangHasJoinedAttempts);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.mojangHasJoinedTimeoutMs);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });

      if (response.status === 200) {
        const body = (await response.json()) as MojangHasJoinedRaw;
        if (!body?.id || !body?.name) {
          throw new Error('Mojang hasJoined returned 200 without id/name');
        }
        return { uuid: normalizeUuid(body.id), username: body.name };
      }

      if (response.status === 204 || (response.status >= 400 && response.status < 500)) {
        if (attempt < attempts) {
          await sleep(config.mojangRetryDelayMs);
          continue;
        }
        return null;
      }

      throw Errors.mojangUnavailable();
    } catch (error) {
      if (error instanceof Error && error.name === 'AppError') throw error;
      if (attempt >= attempts) throw Errors.mojangUnavailable(error);
      await sleep(config.mojangRetryDelayMs);
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}
