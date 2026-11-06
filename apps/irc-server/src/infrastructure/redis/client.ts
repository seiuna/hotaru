import { Redis } from 'ioredis';
import type { AppConfig } from '../../config/env.js';

let client: Redis | null = null;

export function createRedis(config: AppConfig): Redis {
  if (client) return client;
  client = new Redis(config.redisUrl, {
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    connectTimeout: 5000,
  });
  client.on('error', () => {
    // Reconnection noise: the health endpoint reports the real state.
  });
  return client;
}

export function getRedis(): Redis {
  if (!client) throw new Error('Redis not initialised');
  return client;
}

export async function closeRedis(): Promise<void> {
  if (!client) return;
  await client.quit().catch(() => client?.disconnect());
  client = null;
}

export async function pingRedis(): Promise<void> {
  await getRedis().ping();
}
