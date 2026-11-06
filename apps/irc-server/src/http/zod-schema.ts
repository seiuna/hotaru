import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';

/**
 * Zod → JSON Schema for Fastify's OpenAPI and serialisation.
 *
 * `jsonSchema7` is deliberate: Ajv (which Fastify uses) rejects OpenAPI 3.0's
 * boolean `exclusiveMinimum`, and `.nullable()` must become `type: [x, 'null']`.
 * Booting with the wrong target throws FST_ERR_SCH_SERIALIZATION_BUILD.
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
    'anyOf',
    'oneOf',
    'allOf',
    'not',
  ]) {
    if (key in schema) normalizeExclusiveBounds(schema[key]);
  }
}

/** First X-Forwarded-For hop that our trusted edge wrote (we replace, not append). */
export function clientIp(headers: Record<string, unknown>, fallback: string): string | null {
  const forwarded = headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    const hops = forwarded
      .split(',')
      .map((hop) => hop.trim())
      .filter(Boolean);
    const last = hops[hops.length - 1];
    if (last) return last;
  }
  return fallback || null;
}
