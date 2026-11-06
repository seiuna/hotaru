import type { Redis } from 'ioredis';
import { presenceKeys } from '@skymatrix/srp-protocol';
import type { AppContext } from '../context.js';
import type { ManagedConnection } from './registry.js';

export interface PresenceRecord {
  connectionId: string;
  userId: string;
  minecraftUuid: string;
  instanceId: string;
  connectedAt: number;
  lastHeartbeat: number;
}

/**
 * Cross-node presence in Redis (design §10.1).
 *
 * A set member is never proof of life on its own: the per-connection record has
 * the TTL, and readers must check it. This is what keeps a crashed node from
 * leaving "ghost online" players behind.
 */
export class PresenceStore {
  constructor(
    private readonly redis: Redis,
    private readonly instanceId: string,
    private readonly ttlMs: number,
  ) {}

  private connKey(connectionId: string): string {
    return presenceKeys.connection(connectionId);
  }

  async register(connection: ManagedConnection): Promise<void> {
    const record: PresenceRecord = {
      connectionId: connection.connectionId,
      userId: connection.userId,
      minecraftUuid: connection.minecraftUuid,
      instanceId: this.instanceId,
      connectedAt: connection.connectedAt,
      lastHeartbeat: connection.lastHeartbeatAt,
    };
    const pipeline = this.redis.pipeline();
    pipeline.set(this.connKey(connection.connectionId), JSON.stringify(record), 'PX', this.ttlMs);
    pipeline.sadd(presenceKeys.userConnections(connection.minecraftUuid), connection.connectionId);
    pipeline.sadd(presenceKeys.instanceConnections(this.instanceId), connection.connectionId);
    pipeline.pexpire(presenceKeys.userConnections(connection.minecraftUuid), this.ttlMs);
    pipeline.pexpire(presenceKeys.instanceConnections(this.instanceId), this.ttlMs);
    await pipeline.exec();
  }

  async touch(connection: ManagedConnection): Promise<void> {
    const record: PresenceRecord = {
      connectionId: connection.connectionId,
      userId: connection.userId,
      minecraftUuid: connection.minecraftUuid,
      instanceId: this.instanceId,
      connectedAt: connection.connectedAt,
      lastHeartbeat: connection.lastHeartbeatAt,
    };
    const pipeline = this.redis.pipeline();
    pipeline.set(this.connKey(connection.connectionId), JSON.stringify(record), 'PX', this.ttlMs);
    pipeline.pexpire(presenceKeys.userConnections(connection.minecraftUuid), this.ttlMs);
    pipeline.pexpire(presenceKeys.instanceConnections(this.instanceId), this.ttlMs);
    await pipeline.exec();
  }

  async unregister(connection: ManagedConnection): Promise<void> {
    const pipeline = this.redis.pipeline();
    pipeline.del(this.connKey(connection.connectionId));
    pipeline.srem(presenceKeys.userConnections(connection.minecraftUuid), connection.connectionId);
    pipeline.srem(presenceKeys.instanceConnections(this.instanceId), connection.connectionId);
    await pipeline.exec();
  }

  /** Online iff at least one connection record still exists. */
  async isOnline(minecraftUuid: string): Promise<boolean> {
    const ids = await this.redis.smembers(presenceKeys.userConnections(minecraftUuid));
    if (ids.length === 0) return false;
    const pipeline = this.redis.pipeline();
    for (const id of ids) pipeline.exists(this.connKey(id));
    const results = await pipeline.exec();
    return (results ?? []).some(([error, value]) => !error && Number(value) === 1);
  }

  async listRecords(minecraftUuid: string): Promise<PresenceRecord[]> {
    const ids = await this.redis.smembers(presenceKeys.userConnections(minecraftUuid));
    if (ids.length === 0) return [];
    const values = await this.redis.mget(ids.map((id) => this.connKey(id)));
    const records: PresenceRecord[] = [];
    for (const raw of values) {
      if (!raw) continue;
      try {
        records.push(JSON.parse(raw) as PresenceRecord);
      } catch {
        // Skip corrupt records; TTL will drop them.
      }
    }
    return records;
  }

  async onlineCount(): Promise<number> {
    const ids = await this.redis.smembers(presenceKeys.instanceConnections(this.instanceId));
    if (ids.length === 0) return 0;
    const pipeline = this.redis.pipeline();
    for (const id of ids) pipeline.exists(this.connKey(id));
    const results = await pipeline.exec();
    return (results ?? []).filter(([error, value]) => !error && Number(value) === 1).length;
  }

  /** Drops set members whose connection record already expired. */
  async prune(): Promise<number> {
    const ids = await this.redis.smembers(presenceKeys.instanceConnections(this.instanceId));
    if (ids.length === 0) return 0;
    const pipeline = this.redis.pipeline();
    for (const id of ids) pipeline.exists(this.connKey(id));
    const results = await pipeline.exec();
    const dead: string[] = [];
    (results ?? []).forEach(([error, value], index) => {
      if (!error && Number(value) === 0) {
        const id = ids[index];
        if (id) dead.push(id);
      }
    });
    if (dead.length > 0) {
      await this.redis.srem(presenceKeys.instanceConnections(this.instanceId), ...dead);
    }
    return dead.length;
  }
}

export function createPresenceStore(ctx: AppContext): PresenceStore {
  return new PresenceStore(ctx.redis, ctx.instanceId, ctx.config.presenceTtlMs);
}
