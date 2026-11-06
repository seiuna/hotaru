import type { DeliveredMessageFrame } from '@skymatrix/srp-protocol';
import type { ConnectionHandle, DeliverableMessage, MessageDispatcher } from './contracts.js';
import type { ConnectionRegistry } from './contracts.js';

/** Frames handed to a recipient always carry server-attested sender/time fields. */
export function toDeliveredFrame(message: DeliverableMessage): DeliveredMessageFrame {
  return {
    v: 1,
    id: message.messageId,
    op: 'MESSAGE',
    type: message.type,
    route: message.route,
    payload: message.payload,
    ttlMs: Math.max(0, message.expireAt - message.receivedAt),
    replyTo: message.replyTo ?? null,
    sender: {
      userId: message.sender.userId,
      minecraftUuid: message.sender.minecraftUuid,
    },
    receivedAt: message.receivedAt,
    expireAt: message.expireAt,
  };
}

export class Dispatcher implements MessageDispatcher {
  constructor(private readonly registry: ConnectionRegistry) {}

  deliverToUser(minecraftUuid: string, message: DeliverableMessage): number {
    return this.deliverToConnections(this.registry.listByUser(minecraftUuid), message);
  }

  deliverToConnections(
    connections: readonly ConnectionHandle[],
    message: DeliverableMessage,
  ): number {
    if (connections.length === 0) return 0;
    const frame = toDeliveredFrame(message);
    let delivered = 0;
    for (const connection of connections) {
      if (!connection.isOpen) continue;
      try {
        if (connection.send(frame)) delivered += 1;
      } catch {
        // A throwing socket must not abort fan-out for everyone else.
      }
    }
    return delivered;
  }

  broadcast(message: DeliverableMessage, options: { excludeMinecraftUuid?: string } = {}): number {
    const exclude = options.excludeMinecraftUuid;
    const targets = this.registry
      .listAll()
      .filter((connection) => (exclude ? connection.minecraftUuid !== exclude : true));
    return this.deliverToConnections(targets, message);
  }
}
