import type { RouteMode } from '@hotaru/srp-protocol';

/**
 * Interfaces the IRC core exposes to feature modules (groups, filters, REST).
 * Kept in one file so the core and the modules can be built independently.
 */

/** One live WebSocket, as seen by modules that need to fan out messages. */
export interface ConnectionHandle {
  readonly connectionId: string;
  /** Internal user id (JWT `sub`). */
  readonly userId: string;
  /** Mojang UUID, lower-case dashed — the identity used for groups and presence. */
  readonly minecraftUuid: string;
  readonly instanceId: string;
  readonly connectedAt: number;
  readonly isOpen: boolean;
  /** Serialises and enqueues a frame. Returns false when the socket is gone/backpressured. */
  send(frame: unknown): boolean;
  close(reason: string): void;
}

export interface ConnectionRegistry {
  listByUser(minecraftUuid: string): ConnectionHandle[];
  listAll(): ConnectionHandle[];
  get(connectionId: string): ConnectionHandle | undefined;
  count(): number;
  /** Connected UUIDs (deduplicated), for presence snapshots. */
  onlineUuids(): string[];
}

/** A validated, authorised, server-stamped message ready for fan-out. */
export interface DeliverableMessage {
  messageId: string;
  type: string;
  route: { mode: RouteMode; target: string | null };
  payload: unknown;
  /** Server-attested sender (never taken from the payload). */
  sender: { userId: string; minecraftUuid: string };
  receivedAt: number;
  expireAt: number;
  replyTo?: string | null;
}

export interface MessageDispatcher {
  /** Fan out to every live connection of one player. Returns the number of sockets enqueued. */
  deliverToUser(minecraftUuid: string, message: DeliverableMessage): number;
  /** Fan out to an explicit connection set (already filtered by the caller). */
  deliverToConnections(connections: readonly ConnectionHandle[], message: DeliverableMessage): number;
  /** Fan out to everyone currently online. Returns the number of sockets enqueued. */
  broadcast(message: DeliverableMessage, options?: { excludeMinecraftUuid?: string }): number;
}

/* ------------------------------------------------------------------ */
/* Groups (implemented in src/modules/groups)                          */
/* ------------------------------------------------------------------ */

export type GroupRole = 'OWNER' | 'ADMIN' | 'MEMBER';
export type GroupVisibility = 'PRIVATE' | 'PUBLIC';

export interface GroupSummary {
  id: string;
  name: string;
  ownerUuid: string;
  visibility: GroupVisibility;
  maxMembers: number;
  status: 'ACTIVE';
  createdAt: string;
  updatedAt: string;
}

export interface GroupMembership {
  groupId: string;
  userUuid: string;
  role: GroupRole;
  joinedAt: string;
}

export interface GroupService {
  createGroup(input: { ownerUuid: string; name: string; maxMembers?: number }): Promise<GroupSummary>;
  listGroupsForUser(userUuid: string): Promise<GroupSummary[]>;
  /** `viewerUuid` must be a member; otherwise GROUP_ACCESS_DENIED / GROUP_NOT_FOUND. */
  getGroup(groupId: string, viewerUuid: string): Promise<GroupSummary>;
  updateGroup(
    groupId: string,
    actorUuid: string,
    patch: { name?: string; visibility?: GroupVisibility; maxMembers?: number },
  ): Promise<GroupSummary>;
  deleteGroup(groupId: string, actorUuid: string): Promise<void>;
  addMember(groupId: string, actorUuid: string, targetUuid: string, role?: Exclude<GroupRole, 'OWNER'>): Promise<GroupMembership>;
  removeMember(groupId: string, actorUuid: string, targetUuid: string): Promise<void>;
  setMemberRole(groupId: string, actorUuid: string, targetUuid: string, role: GroupRole): Promise<GroupMembership>;
  membership(groupId: string, userUuid: string): Promise<GroupMembership | null>;
  memberUuids(groupId: string): Promise<string[]>;
}

/* ------------------------------------------------------------------ */
/* Filters (implemented in src/modules/filters)                        */
/* ------------------------------------------------------------------ */

export type FilterScope = 'GLOBAL' | 'GROUP' | 'USER';
export type FilterAction = 'ALLOW' | 'DENY';

export interface FilterRule {
  id: string;
  scope: FilterScope;
  targetId: string | null;
  pattern: string;
  action: FilterAction;
  enabled: boolean;
  createdAt: string;
}

export interface FilterService {
  /** Global deny rules apply to DIRECT, GROUP and BROADCAST alike. */
  isGloballyDenied(type: string): Promise<boolean>;
  /** Group deny rules apply only to messages routed to that group. */
  isGroupDenied(groupId: string, type: string): Promise<boolean>;
  /** Per-recipient deny rules; called once per target connection owner. */
  isUserDenied(userUuid: string, type: string): Promise<boolean>;
  listRules(scope: FilterScope, targetId: string | null): Promise<FilterRule[]>;
  replaceRules(
    scope: FilterScope,
    targetId: string | null,
    rules: Array<{ pattern: string; action: FilterAction }>,
    actorUuid: string,
  ): Promise<FilterRule[]>;
}

/* ------------------------------------------------------------------ */
/* Audit (implemented in src/modules/audit)                            */
/* ------------------------------------------------------------------ */

export interface AuditEntry {
  event: string;
  actorUuid?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  ip?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface AuditService {
  record(entry: AuditEntry): Promise<void>;
}
