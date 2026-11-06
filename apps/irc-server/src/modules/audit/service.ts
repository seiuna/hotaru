import type { AppContext } from '../../context.js';
import type { AuditEntry, AuditService } from '../../runtime/contracts.js';
import { IrcAuditLogModel } from './model.js';

/**
 * Audit sink. `record()` is deliberately fire-and-forget: a broken audit pipeline
 * must never turn a successful group operation into a 500, so every failure is
 * swallowed after being reported once on stderr.
 *
 * Content safety is enforced structurally, not by convention: keys that smell
 * like a message body or a credential are dropped, nested objects are bounded, and
 * every string is truncated. An audit entry is a set of identifiers and decisions.
 */

const MAX_EVENT_LENGTH = 128;
const MAX_IDENTIFIER_LENGTH = 200;
const MAX_STRING_LENGTH = 200;
const MAX_METADATA_KEYS = 20;
const MAX_METADATA_DEPTH = 2;
const MAX_ARRAY_LENGTH = 20;

/** Keys that would indicate a payload, a token or a secret (matched on the key stem). */
const FORBIDDEN_KEYS = new Set([
  'payload',
  'payloads',
  'message',
  'messages',
  'content',
  'contents',
  'body',
  'text',
  'json',
  'data',
  'token',
  'tokens',
  'authorization',
  'password',
  'passwords',
  'secret',
  'secrets',
  'jwt',
  'chat',
  'cookie',
]);

/**
 * Suffix check so `accessToken`, `messageBody` and `chatText` are dropped while
 * identifiers such as `messageId` and `memberUuid` survive.
 */
const FORBIDDEN_SUFFIXES = ['payload', 'content', 'body', 'text', 'token', 'secret', 'password', 'jwt'];

function isForbiddenKey(key: string): boolean {
  const normalized = key.replace(/[_\-\s]/g, '').toLowerCase();
  if (FORBIDDEN_KEYS.has(normalized)) return true;
  return FORBIDDEN_SUFFIXES.some(
    (suffix) => normalized.length > suffix.length && normalized.endsWith(suffix),
  );
}

/** Trim, cap and null out empty identifiers. */
export function normalizeIdentifier(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_IDENTIFIER_LENGTH);
}

function sanitizeValue(value: unknown, depth: number): unknown {
  switch (typeof value) {
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'string':
      return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
    case 'object': {
      if (value === null) return null;
      if (depth >= MAX_METADATA_DEPTH) return null;
      if (Array.isArray(value)) {
        const items = value
          .slice(0, MAX_ARRAY_LENGTH)
          .map((item) => sanitizeValue(item, depth + 1))
          .filter((item) => item !== undefined);
        return items;
      }
      return sanitizeMetadata(value as Record<string, unknown>, depth + 1);
    }
    default:
      // Functions, symbols, bigints and undefined are not auditable data.
      return undefined;
  }
}

/**
 * Drops forbidden keys and flattens everything else into primitives of bounded
 * size. Returns null when nothing survives (an empty object is not metadata).
 */
export function sanitizeMetadata(
  input: Record<string, unknown> | null | undefined,
  depth = 0,
): Record<string, unknown> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (depth > MAX_METADATA_DEPTH) return null;

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input).slice(0, MAX_METADATA_KEYS)) {
    if (isForbiddenKey(key)) continue;
    const sanitized = sanitizeValue(value, depth);
    if (sanitized !== undefined) output[key] = sanitized;
  }

  return Object.keys(output).length > 0 ? output : null;
}

/**
 * Builds the audit service. The clock comes from `ctx.now()` so tests can pin the
 * timestamp, and `createdAt` is written explicitly (TTL indexes use it).
 */
export function createAuditService(ctx: AppContext): AuditService {
  return {
    async record(entry: AuditEntry): Promise<void> {
      try {
        const event = typeof entry.event === 'string' ? entry.event.trim() : '';
        if (event.length === 0) return;

        await IrcAuditLogModel.create({
          event: event.slice(0, MAX_EVENT_LENGTH),
          actorUuid: normalizeIdentifier(entry.actorUuid),
          targetType: normalizeIdentifier(entry.targetType),
          targetId: normalizeIdentifier(entry.targetId),
          ip: normalizeIdentifier(entry.ip),
          metadata: sanitizeMetadata(entry.metadata),
          createdAt: new Date(ctx.now()),
        });
      } catch (error) {
        // Never surface an audit failure to the caller of the action it describes.
        console.error('[irc-audit] failed to persist audit event', entry.event, error);
      }
    },
  };
}
