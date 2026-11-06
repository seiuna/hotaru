import { randomBytes } from 'node:crypto';

/**
 * Identity normalisation shared by groups and filters.
 *
 * The auth server issues the canonical Mojang UUID (dashed, lowercase) as the
 * `minecraft_uuid` claim and the routing layer canonicalises DIRECT targets the
 * same way. Every UUID that reaches a collection therefore goes through
 * {@link toCanonicalUuid}, so a member added with the undashed form still matches
 * the JWT identity of the same player.
 *
 * A group id is *ours*, not Mongo's: `grp_<22 url-safe chars>`. It is exposed in
 * REST responses and used as the `route.target` of a GROUP message, so it must
 * stay URL-safe and must never be the ObjectId (which would leak insertion order
 * and couple the wire format to the storage engine).
 */

const BARE_UUID_PATTERN = /^[0-9a-f]{32}$/;
const GROUP_ID_PATTERN = /^grp_[A-Za-z0-9_-]{8,64}$/;

export const GROUP_ID_PREFIX = 'grp_';
export const MAX_USER_ID_LENGTH = 64;

/** Canonical Minecraft UUID: dashed, lowercase. */
function dashed(bare: string): string {
  return `${bare.slice(0, 8)}-${bare.slice(8, 12)}-${bare.slice(12, 16)}-${bare.slice(16, 20)}-${bare.slice(20)}`;
}

/**
 * Canonicalises a UUID-ish identifier; returns `null` when the value cannot be a
 * UUID. Used for client-supplied member UUIDs, where a typo must be rejected
 * instead of silently stored as an unmatchable membership.
 */
export function canonicalUuidOrNull(value: string): string | null {
  const bare = value.trim().toLowerCase().replace(/-/g, '');
  if (!BARE_UUID_PATTERN.test(bare)) return null;
  return dashed(bare);
}

/**
 * Canonicalises an identifier we did not receive from a client (a JWT claim, a
 * route parameter echoed by the caller). Non-UUID values are kept verbatim (in
 * lowercase) rather than rejected: the identity is already authenticated, and
 * rejecting it here would turn a token quirk into a 400 on every request.
 */
export function toCanonicalUuid(value: string): string {
  return canonicalUuidOrNull(value) ?? value.trim().toLowerCase();
}

/** Fresh opaque group id. */
export function newGroupId(): string {
  return `${GROUP_ID_PREFIX}${randomBytes(12).toString('base64url')}`;
}

/** Format check, not an existence check. */
export function isGroupId(value: string): boolean {
  return GROUP_ID_PATTERN.test(value);
}
