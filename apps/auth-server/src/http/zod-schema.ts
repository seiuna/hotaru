import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';

/**
 * Rewrites draft-04 style exclusive bounds into the numeric draft-07 form that
 * Fastify 5's schema compiler (Ajv) accepts:
 *
 *   { minimum: 0, exclusiveMinimum: true }  ->  { exclusiveMinimum: 0 }
 *
 * `zodToJsonSchema` may emit either form depending on its target, and a
 * boolean exclusiveMinimum makes `app.ready()` throw
 * FST_ERR_SCH_SERIALIZATION_BUILD, which takes the whole server down at boot.
 */
function normalizeExclusiveBounds(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) normalizeExclusiveBounds(item);
    return;
  }
  if (!node || typeof node !== 'object') return;

  const schema = node as Record<string, unknown>;

  if (schema.exclusiveMinimum === true && typeof schema.minimum === 'number') {
    schema.exclusiveMinimum = schema.minimum;
    delete schema.minimum;
  }
  if (schema.exclusiveMaximum === true && typeof schema.maximum === 'number') {
    schema.exclusiveMaximum = schema.maximum;
    delete schema.maximum;
  }

  for (const key of [
    'properties',
    'patternProperties',
    'items',
    'additionalProperties',
    'additionalItems',
    'contains',
    'propertyNames',
    'not',
    'anyOf',
    'oneOf',
    'allOf',
    'if',
    'then',
    'else',
  ]) {
    if (key in schema) normalizeExclusiveBounds(schema[key]);
  }
}

/**
 * Converts a Zod schema into the JSON Schema shape fastify-swagger needs.
 * `jsonSchema7` is deliberate: it emits numeric exclusive bounds and
 * `type: [x, 'null']` for `.nullable()`, both of which Ajv accepts — unlike
 * OpenAPI 3.0's boolean `exclusiveMinimum` / non-standard `nullable`.
 */
export function toJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const json = zodToJsonSchema(schema, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
    strictUnions: true,
  }) as Record<string, unknown>;

  delete json.$schema;
  normalizeExclusiveBounds(json);
  return json;
}

/**
 * Client IP for rate limiting, audit records and the Mojang `ip` parameter.
 *
 * Takes the LAST X-Forwarded-For hop, not the first: the left-most entry is
 * whatever the original client sent, so it is attacker-controlled. The right-most
 * entry is the one appended by the trusted edge proxy in front of us. Our own
 * Caddyfile replaces the header with `{remote_host}` rather than appending, so in
 * the supported deployment there is exactly one hop and this returns it.
 */
export function clientIp(headers: Record<string, unknown>, fallback: string): string | null {
  const forwarded = headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    const hops = forwarded
      .split(',')
      .map((hop) => hop.trim())
      .filter((hop) => hop.length > 0);
    const last = hops[hops.length - 1];
    if (last) return last;
  }
  return fallback || null;
}

export function userAgentOf(headers: Record<string, unknown>): string | null {
  const ua = headers['user-agent'];
  return typeof ua === 'string' && ua.length > 0 ? ua.slice(0, 512) : null;
}
