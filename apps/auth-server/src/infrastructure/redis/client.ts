import { Redis } from 'ioredis';
import type { AppConfig } from '../../config/env.js';

let client: Redis | null = null;

export function createRedis(config: AppConfig): Redis {
  if (client) return client;
  client = new Redis(config.redisUrl, {
    lazyConnect: false,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    connectTimeout: 5000,
  });
  client.on('error', () => {
    // ioredis emits an error per failed reconnect; the health endpoint reports
    // the real state, so swallow the noisy event.
  });
  return client;
}

export function getRedis(): Redis {
  if (!client) throw new Error('Redis not initialised; call createRedis() first');
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
