import type { WebSocket } from 'ws';
import type { IrcTagKey } from '@hotaru/srp-protocol';
import type { ConnectionHandle, ConnectionRegistry } from './contracts.js';

/** A live connection plus the mutable state the core needs. */
export interface ManagedConnection extends ConnectionHandle {
  /** Mutable here: the core flips this on close before dropping the socket. */
  isOpen: boolean;
  socket: WebSocket;
  /** Scopes from the verified JWT (never from the client). */
  scopes: string[];
  username: string;
  nickname: string;
  tags: IrcTagKey[];
  lastHeartbeatAt: number;
  /** Pending pong timer id, cleared when the client answers. */
  pongTimer: ReturnType<typeof setTimeout> | null;
  ip: string | null;
  userAgent: string | null;
}

/**
 * In-memory index of live sockets. Redis holds the cross-node view; this is the
 * authoritative list for connections owned by *this* process, which is what
 * makes fan-out local and cheap.
 */
export class InMemoryRegistry implements ConnectionRegistry {
  private readonly byId = new Map<string, ManagedConnection>();
  private readonly byUser = new Map<string, Set<string>>();
  private readonly byIp = new Map<string, number>();

  add(connection: ManagedConnection): void {
    this.byId.set(connection.connectionId, connection);
    let set = this.byUser.get(connection.minecraftUuid);
    if (!set) {
      set = new Set();
      this.byUser.set(connection.minecraftUuid, set);
    }
    set.add(connection.connectionId);
    if (connection.ip) this.byIp.set(connection.ip, (this.byIp.get(connection.ip) ?? 0) + 1);
  }

  remove(connectionId: string): ManagedConnection | undefined {
    const connection = this.byId.get(connectionId);
    if (!connection) return undefined;
    this.byId.delete(connectionId);
    const set = this.byUser.get(connection.minecraftUuid);
    if (set) {
      set.delete(connectionId);
      if (set.size === 0) this.byUser.delete(connection.minecraftUuid);
    }
    if (connection.ip) {
      const count = (this.byIp.get(connection.ip) ?? 1) - 1;
      if (count <= 0) this.byIp.delete(connection.ip);
      else this.byIp.set(connection.ip, count);
    }
    return connection;
  }

  get(connectionId: string): ManagedConnection | undefined {
    return this.byId.get(connectionId);
  }

  listByUser(minecraftUuid: string): ManagedConnection[] {
    const ids = this.byUser.get(minecraftUuid);
    if (!ids) return [];
    return [...ids]
      .map((id) => this.byId.get(id))
      .filter((connection): connection is ManagedConnection => Boolean(connection?.isOpen));
  }

  listAll(): ManagedConnection[] {
    return [...this.byId.values()].filter((connection) => connection.isOpen);
  }

  count(): number {
    return this.byId.size;
  }

  onlineUuids(): string[] {
    return [...this.byUser.keys()].filter((uuid) => this.listByUser(uuid).length > 0);
  }

  connectionsFromIp(ip: string | null): number {
    if (!ip) return 0;
    return this.byIp.get(ip) ?? 0;
  }
}
