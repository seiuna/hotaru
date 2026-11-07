import { z } from 'zod';

/**
 * Hotaru Relay Protocol v1 — wire contract.
 *
 * This package is the single source of truth for the IRC server, its REST API and
 * any client SDK: envelope shapes, operation names, error codes, limits and the
 * wildcard matcher used by the filter engine.
 */

export const PROTOCOL_VERSION = 1 as const;

/* ------------------------------------------------------------------ */
/* Operations                                                          */
/* ------------------------------------------------------------------ */

export const OPS = [
  'READY',
  'MESSAGE',
  'ACK',
  'ERROR',
  'PRESENCE',
  'GROUP_EVENT',
  'PING',
  'PONG',
] as const;
export type Op = (typeof OPS)[number];

/* ------------------------------------------------------------------ */
/* Error codes (design §14)                                            */
/* ------------------------------------------------------------------ */

export const SRP_ERROR_CODES = [
  'UNAUTHORIZED',
  'TOKEN_EXPIRED',
  'SCOPE_DENIED',
  'SESSION_REVOKED',
  'INVALID_ENVELOPE',
  'UNSUPPORTED_VERSION',
  'INVALID_TYPE',
  'TYPE_DENIED',
  'TARGET_OFFLINE',
  'GROUP_NOT_FOUND',
  'GROUP_ACCESS_DENIED',
  'BROADCAST_DENIED',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  'MESSAGE_EXPIRED',
  'DUPLICATE_MESSAGE_ID',
  'INTERNAL_ERROR',
] as const;
export type SrpErrorCode = (typeof SRP_ERROR_CODES)[number];

/** Statuses carried by an ACK. Deliberately not "read"/"processed". */
export const ACK_STATUSES = ['accepted', 'delivered', 'failed'] as const;
export type AckStatus = (typeof ACK_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Limits (design §15.1)                                               */
/* ------------------------------------------------------------------ */

export const LIMITS = {
  /** `chat.message` + namespaces stay well under this. */
  maxTypeLength: 128,
  /** Business payload limit enforced before parsing. */
  maxPayloadBytes: 64 * 1024,
  /** Whole WebSocket frame / message budget. */
  maxFrameBytes: 128 * 1024,
  defaultTtlMs: 10_000,
  minTtlMs: 1_000,
  maxTtlMs: 60_000,
  /** Message ids are client-generated UUIDv7-ish strings. */
  maxMessageIdLength: 64,
  /** Reserved namespaces no business message may use. */
  reservedPrefixes: ['protocol.', 'srp.'] as readonly string[],
} as const;

/* ------------------------------------------------------------------ */
/* Type names and patterns                                             */
/* ------------------------------------------------------------------ */

export const TYPE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
export const ROUTE_MODES = ['DIRECT', 'GROUP', 'BROADCAST'] as const;
export type RouteMode = (typeof ROUTE_MODES)[number];

/**
 * A message type is `namespace.category.action`-ish: ASCII letters, digits, dot,
 * underscore and hyphen. Anything else is rejected outright — the server never
 * interprets the name beyond routing and filtering.
 */
export function validateTypeName(type: string): { ok: true } | { ok: false; reason: string } {
  if (type.length === 0) return { ok: false, reason: 'type is empty' };
  if (type.length > LIMITS.maxTypeLength) {
    return { ok: false, reason: `type exceeds ${LIMITS.maxTypeLength} characters` };
  }
  if (!TYPE_NAME_PATTERN.test(type)) {
    return { ok: false, reason: 'type may only contain A-Z a-z 0-9 . _ -' };
  }
  const reserved = LIMITS.reservedPrefixes.find((prefix) => type.startsWith(prefix));
  if (reserved) return { ok: false, reason: `type uses the reserved prefix ${reserved}` };
  if (type.startsWith('.')) return { ok: false, reason: 'type may not start with a dot' };
  if (type.includes('..')) return { ok: false, reason: 'type may not contain an empty segment' };
  return { ok: true };
}

/**
 * Filter patterns are intentionally trivial so a malicious rule cannot burn CPU:
 *
 *   "chat.message"  exact match
 *   "chat.*"        everything under the `chat` namespace
 *   "*"             everything
 *
 * Only a trailing `*` segment is accepted; no regex, no character classes.
 */
export function validatePattern(pattern: string): { ok: true } | { ok: false; reason: string } {
  if (pattern === '*') return { ok: true };
  if (pattern.length === 0) return { ok: false, reason: 'pattern is empty' };
  if (pattern.length > LIMITS.maxTypeLength) return { ok: false, reason: 'pattern is too long' };
  if (!TYPE_NAME_PATTERN.test(pattern.replace(/\*$/, ''))) {
    return { ok: false, reason: 'pattern may only contain A-Z a-z 0-9 . _ - and a trailing *' };
  }
  const starIndex = pattern.indexOf('*');
  if (starIndex !== -1 && starIndex !== pattern.length - 1) {
    return { ok: false, reason: 'the only supported wildcard is a trailing *' };
  }
  if (pattern.endsWith('.*') === false && pattern !== '*' && starIndex !== -1) {
    return { ok: false, reason: 'a wildcard must follow a dot, e.g. chat.*' };
  }
  return { ok: true };
}

/** True when `pattern` (validated) matches `type`. */
export function matchTypePattern(type: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern === type) return true;
  if (pattern.endsWith('.*')) {
    const namespace = pattern.slice(0, -2);
    // `chat.*` means "everything under chat", not the bare `chat` type.
    return type.startsWith(`${namespace}.`);
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Envelope                                                            */
/* ------------------------------------------------------------------ */

export const routeSchema = z.object({
  mode: z.enum(ROUTE_MODES),
  /** DIRECT: target UUID. GROUP: group id. BROADCAST: null. */
  target: z.string().min(1).max(128).nullable(),
});
export type Route = z.infer<typeof routeSchema>;

const messageIdSchema = z.string().min(1).max(LIMITS.maxMessageIdLength);

/** A client-originated business message. */
export const clientMessageSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  id: messageIdSchema,
  op: z.literal('MESSAGE'),
  type: z.string().min(1).max(LIMITS.maxTypeLength),
  route: routeSchema,
  payload: z.unknown().refine((value) => value !== undefined, { message: 'payload is required' }),
  ttlMs: z.number().int().min(LIMITS.minTtlMs).max(LIMITS.maxTtlMs).optional(),
  replyTo: messageIdSchema.nullable().optional(),
});
export type ClientMessage = z.infer<typeof clientMessageSchema>;

/** Client keepalive (optional; native WS ping/pong is the primary mechanism). */
export const pingSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  id: messageIdSchema,
  op: z.literal('PING'),
});
export type PingFrame = z.infer<typeof pingSchema>;

/** Anything a client may send us. */
export const clientFrameSchema = z.discriminatedUnion('op', [clientMessageSchema, pingSchema]);
export type ClientFrame = z.infer<typeof clientFrameSchema>;

/* ------------------------------------------------------------------ */
/* Server frames                                                       */
/* ------------------------------------------------------------------ */

export interface ReadyFrame {
  v: 1;
  id: string;
  op: 'READY';
  type: 'protocol.ready';
  payload: {
    connectionId: string;
    userId: string;
    minecraftUuid: string;
    instanceId: string;
    heartbeatIntervalMs: number;
    serverTime: number;
  };
}

export interface AckFrame {
  v: 1;
  id: string;
  op: 'ACK';
  type: 'protocol.ack';
  replyTo: string;
  payload: {
    status: AckStatus;
    recipients?: number;
    reason?: SrpErrorCode;
  };
}

export interface ErrorFrame {
  v: 1;
  id: string;
  op: 'ERROR';
  type: 'protocol.error';
  replyTo?: string | null;
  payload: {
    code: SrpErrorCode;
    message: string;
  };
}

export interface PresenceFrame {
  v: 1;
  id: string;
  op: 'PRESENCE';
  type: 'protocol.presence';
  payload: { userId: string; online: boolean };
}

export interface GroupEventFrame {
  v: 1;
  id: string;
  op: 'GROUP_EVENT';
  type: string;
  route: Route;
  payload: Record<string, unknown>;
}

export interface PongFrame {
  v: 1;
  id: string;
  op: 'PONG';
  type: 'protocol.pong';
  replyTo?: string;
}

/** A business message as delivered to a recipient (server-attested fields added). */
export interface DeliveredMessageFrame {
  v: 1;
  id: string;
  op: 'MESSAGE';
  type: string;
  route: Route;
  payload: unknown;
  ttlMs: number;
  replyTo?: string | null;
  /** Added by the server; a client may never set these. */
  sender: { userId: string; minecraftUuid: string };
  receivedAt: number;
  expireAt: number;
}

export type ServerFrame =
  | ReadyFrame
  | AckFrame
  | ErrorFrame
  | PresenceFrame
  | GroupEventFrame
  | PongFrame
  | DeliveredMessageFrame;

/* ------------------------------------------------------------------ */
/* Frame builders                                                     */
/* ------------------------------------------------------------------ */

const randomId = (): string =>
  `srv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export function readyFrame(input: ReadyFrame['payload']): ReadyFrame {
  return { v: 1, id: randomId(), op: 'READY', type: 'protocol.ready', payload: input };
}

export function ackFrame(
  replyTo: string,
  status: AckStatus,
  extra: { recipients?: number; reason?: SrpErrorCode } = {},
): AckFrame {
  const payload: AckFrame['payload'] = { status };
  if (extra.recipients !== undefined) payload.recipients = extra.recipients;
  if (extra.reason !== undefined) payload.reason = extra.reason;
  return { v: 1, id: randomId(), op: 'ACK', type: 'protocol.ack', replyTo, payload };
}

export function errorFrame(
  code: SrpErrorCode,
  message: string,
  replyTo?: string | null,
): ErrorFrame {
  return {
    v: 1,
    id: randomId(),
    op: 'ERROR',
    type: 'protocol.error',
    replyTo: replyTo ?? null,
    payload: { code, message },
  };
}

export function presenceFrame(userId: string, online: boolean): PresenceFrame {
  return {
    v: 1,
    id: randomId(),
    op: 'PRESENCE',
    type: 'protocol.presence',
    payload: { userId, online },
  };
}

export function pongFrame(replyTo?: string): PongFrame {
  const frame: PongFrame = { v: 1, id: randomId(), op: 'PONG', type: 'protocol.pong' };
  if (replyTo) frame.replyTo = replyTo;
  return frame;
}

/** Absolute expiry is always computed from the server's clock (design §8.4). */
export function computeExpireAt(receivedAt: number, ttlMs: number | undefined): number {
  return receivedAt + (ttlMs ?? LIMITS.defaultTtlMs);
}

/** Dedupe key: sender + message id, never the id alone (design §8.3). */
export function dedupeKey(senderUserId: string, messageId: string): string {
  return `irc:dedupe:${senderUserId}:${messageId}`;
}

/** Presence keys (design §10.1). */
export const presenceKeys = {
  connection: (connectionId: string) => `irc:presence:conn:${connectionId}`,
  userConnections: (userId: string) => `irc:presence:user:${userId}`,
  instanceConnections: (instanceId: string) => `irc:presence:instance:${instanceId}`,
  nodeChannel: (instanceId: string) => `irc:node:${instanceId}`,
} as const;

/** Revocation fast path shared with the auth server. */
export function sessionRevokedKey(sessionId: string): string {
  return `auth:session:revoked:${sessionId}`;
}

export const REQUIRED_SCOPE = 'hotaru:ircserver' as const;
export const BROADCAST_SCOPE = 'hotaru:irc:broadcast' as const;
