import {
  BROADCAST_SCOPE,
  ackFrame,
  computeExpireAt,
  errorFrame,
  validateTypeName,
  type ClientMessage,
  type SrpErrorCode,
} from '@hotaru/srp-protocol';
import type { AppContext } from '../../context.js';
import type {
  AuditService,
  DeliverableMessage,
  FilterService,
  GroupService,
  MessageDispatcher,
} from '../../runtime/contracts.js';
import type { ManagedConnection } from '../../runtime/registry.js';
import type { ConnectionRegistry } from '../../runtime/contracts.js';
import type { DedupeStore } from '../../runtime/dedupe.js';

export interface RoutingDeps {
  ctx: AppContext;
  registry: ConnectionRegistry;
  dispatcher: MessageDispatcher;
  groups: GroupService;
  filters: FilterService;
  dedupe: DedupeStore;
  audit: AuditService;
}

type Send = (frame: unknown) => void;

const UUID_PATTERN = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** Accepts dashed or undashed; returns the canonical dashed lowercase form. */
export function normalizeUuid(value: string): string | null {
  if (!UUID_PATTERN.test(value)) return null;
  const hex = value.replace(/-/g, '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function fail(send: Send, messageId: string, reason: SrpErrorCode): void {
  send(ackFrame(messageId, 'failed', { reason }));
}

/**
 * Handles one `MESSAGE` frame end to end: validation → global filter → dedupe →
 * TTL → per-mode routing → ACK. The sender identity is always the connection's,
 * never anything the payload claims.
 */
export async function handleMessageFrame(
  deps: RoutingDeps,
  connection: ManagedConnection,
  frame: ClientMessage,
  send: Send,
): Promise<void> {
  const { ctx } = deps;
  const messageId = frame.id;

  const typeCheck = validateTypeName(frame.type);
  if (!typeCheck.ok) {
    send(errorFrame('INVALID_TYPE', typeCheck.reason, messageId));
    return;
  }

  if (await deps.filters.isGloballyDenied(frame.type)) {
    fail(send, messageId, 'TYPE_DENIED');
    await deps.audit.record({
      event: 'irc.message.type_denied',
      actorUuid: connection.minecraftUuid,
      targetType: 'type',
      targetId: frame.type,
      ip: connection.ip,
      metadata: { scope: 'GLOBAL', messageId },
    });
    return;
  }

  const duplicate = await deps.dedupe.begin(connection.userId, messageId, frame.payload);
  if (duplicate.status === 'duplicate-different') {
    fail(send, messageId, 'DUPLICATE_MESSAGE_ID');
    return;
  }
  if (duplicate.status === 'duplicate-same') {
    // Already accepted and fanned out: acknowledge without sending it twice.
    send(ackFrame(messageId, 'accepted'));
    return;
  }

  const receivedAt = ctx.now();
  const expireAt = computeExpireAt(receivedAt, frame.ttlMs);
  if (receivedAt > expireAt) {
    fail(send, messageId, 'MESSAGE_EXPIRED');
    return;
  }

  const message: DeliverableMessage = {
    messageId,
    type: frame.type,
    route: frame.route,
    payload: frame.payload,
    sender: {
      userId: connection.userId,
      minecraftUuid: connection.minecraftUuid,
      nickname: connection.nickname,
      tags: connection.tags,
    },
    receivedAt,
    expireAt,
    replyTo: frame.replyTo ?? null,
  };

  send(ackFrame(messageId, 'accepted'));

  switch (frame.route.mode) {
    case 'DIRECT':
      await routeDirect(deps, connection, message, send);
      return;
    case 'GROUP':
      await routeGroup(deps, connection, message, send);
      return;
    case 'BROADCAST':
      await routeBroadcast(deps, connection, message, send);
      return;
    default:
      send(errorFrame('INVALID_ENVELOPE', 'Unsupported route mode', messageId));
  }
}

async function routeDirect(
  deps: RoutingDeps,
  connection: ManagedConnection,
  message: DeliverableMessage,
  send: Send,
): Promise<void> {
  const rawTarget = message.route.target;
  const target = rawTarget ? normalizeUuid(rawTarget) : null;
  if (!target) {
    send(errorFrame('INVALID_ENVELOPE', 'DIRECT requires a UUID target', message.messageId));
    return;
  }

  if (deps.ctx.now() > message.expireAt) {
    fail(send, message.messageId, 'MESSAGE_EXPIRED');
    return;
  }

  const connections = deps.registry.listByUser(target);
  if (connections.length === 0) {
    send(ackFrame(message.messageId, 'failed', { reason: 'TARGET_OFFLINE' }));
    return;
  }

  if (await deps.filters.isUserDenied(target, message.type)) {
    fail(send, message.messageId, 'TYPE_DENIED');
    return;
  }

  const delivered = deps.dispatcher.deliverToConnections(connections, message);
  if (delivered === 0) {
    send(ackFrame(message.messageId, 'failed', { reason: 'TARGET_OFFLINE' }));
    return;
  }
  send(ackFrame(message.messageId, 'delivered', { recipients: delivered }));
}

async function routeGroup(
  deps: RoutingDeps,
  connection: ManagedConnection,
  message: DeliverableMessage,
  send: Send,
): Promise<void> {
  const groupId = message.route.target;
  if (!groupId) {
    send(errorFrame('INVALID_ENVELOPE', 'GROUP requires a group id target', message.messageId));
    return;
  }

  let membership;
  try {
    membership = await deps.groups.membership(groupId, connection.minecraftUuid);
  } catch {
    fail(send, message.messageId, 'GROUP_NOT_FOUND');
    return;
  }
  if (!membership) {
    // Never reveal whether a private group exists.
    fail(send, message.messageId, 'GROUP_ACCESS_DENIED');
    return;
  }

  if (await deps.filters.isGroupDenied(groupId, message.type)) {
    fail(send, message.messageId, 'TYPE_DENIED');
    return;
  }

  if (deps.ctx.now() > message.expireAt) {
    fail(send, message.messageId, 'MESSAGE_EXPIRED');
    return;
  }

  const members = await deps.groups.memberUuids(groupId);
  const targets = members
    .filter((uuid) => uuid !== connection.minecraftUuid)
    .flatMap((uuid) => deps.registry.listByUser(uuid));

  // Per-recipient deny rules, deduplicated by UUID to avoid repeated lookups.
  const denied = new Map<string, boolean>();
  const allowed = [];
  for (const target of targets) {
    let isDenied = denied.get(target.minecraftUuid);
    if (isDenied === undefined) {
      isDenied = await deps.filters.isUserDenied(target.minecraftUuid, message.type);
      denied.set(target.minecraftUuid, isDenied);
    }
    if (!isDenied) allowed.push(target);
  }

  const delivered = deps.dispatcher.deliverToConnections(allowed, message);
  send(ackFrame(message.messageId, 'delivered', { recipients: delivered }));
}

async function routeBroadcast(
  deps: RoutingDeps,
  connection: ManagedConnection,
  message: DeliverableMessage,
  send: Send,
): Promise<void> {
  const { ctx } = deps;
  const isAdmin = ctx.config.adminUuids.includes(connection.minecraftUuid);
  const hasScope = connection.scopes.includes(BROADCAST_SCOPE);
  if (!ctx.config.broadcastEnabled || (!hasScope && !isAdmin)) {
    fail(send, message.messageId, 'BROADCAST_DENIED');
    return;
  }

  if (deps.ctx.now() > message.expireAt) {
    fail(send, message.messageId, 'MESSAGE_EXPIRED');
    return;
  }

  const all = deps.registry.listAll();
  const denied = new Map<string, boolean>();
  const allowed = [];
  for (const target of all) {
    let isDenied = denied.get(target.minecraftUuid);
    if (isDenied === undefined) {
      isDenied = await deps.filters.isUserDenied(target.minecraftUuid, message.type);
      denied.set(target.minecraftUuid, isDenied);
    }
    if (!isDenied) allowed.push(target);
  }

  const delivered = deps.dispatcher.deliverToConnections(allowed, message);
  await deps.audit.record({
    event: 'irc.broadcast.sent',
    actorUuid: connection.minecraftUuid,
    targetType: 'type',
    targetId: message.type,
    ip: connection.ip,
    metadata: { recipients: delivered, messageId: message.messageId },
  });
  send(ackFrame(message.messageId, 'delivered', { recipients: delivered }));
}
