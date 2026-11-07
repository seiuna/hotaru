import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  ackFrame,
  clientFrameSchema,
  clientMessageSchema,
  computeExpireAt,
  dedupeKey,
  errorFrame,
  matchTypePattern,
  presenceKeys,
  sessionRevokedKey,
  validatePattern,
  validateTypeName,
} from './index.js';

describe('validateTypeName', () => {
  it('accepts namespaced types', () => {
    expect(validateTypeName('chat.message').ok).toBe(true);
    expect(validateTypeName('hotaru.party.state').ok).toBe(true);
    expect(validateTypeName('a_b-c.d1').ok).toBe(true);
  });

  it('rejects malformed or reserved names', () => {
    expect(validateTypeName('').ok).toBe(false);
    expect(validateTypeName('chat message').ok).toBe(false);
    expect(validateTypeName('chat..message').ok).toBe(false);
    expect(validateTypeName('.chat').ok).toBe(false);
    expect(validateTypeName('protocol.ack').ok).toBe(false);
    expect(validateTypeName('srp.internal').ok).toBe(false);
    expect(validateTypeName('a'.repeat(LIMITS.maxTypeLength + 1)).ok).toBe(false);
  });
});

describe('filter patterns', () => {
  it('accepts only the three supported shapes', () => {
    expect(validatePattern('chat.message').ok).toBe(true);
    expect(validatePattern('chat.*').ok).toBe(true);
    expect(validatePattern('*').ok).toBe(true);
  });

  it('rejects regex-like or mid-string wildcards', () => {
    expect(validatePattern('chat.*.message').ok).toBe(false);
    expect(validatePattern('chat*').ok).toBe(false);
    expect(validatePattern('^chat\\..*$').ok).toBe(false);
  });

  it('matches namespaces without matching prefixes of other namespaces', () => {
    expect(matchTypePattern('chat.message', 'chat.message')).toBe(true);
    expect(matchTypePattern('chat.message', 'chat.*')).toBe(true);
    expect(matchTypePattern('chat.a.b', 'chat.*')).toBe(true);
    expect(matchTypePattern('chat.message', '*')).toBe(true);
    expect(matchTypePattern('chatty.message', 'chat.*')).toBe(false);
    expect(matchTypePattern('chat', 'chat.*')).toBe(false);
    expect(matchTypePattern('chat.message', 'chat')).toBe(false);
  });
});

describe('envelope schema', () => {
  const valid = {
    v: 1,
    id: 'msg-1',
    op: 'MESSAGE',
    type: 'chat.message',
    route: { mode: 'DIRECT', target: '4c1099df-e202-4e64-9ea2-9039be420143' },
    payload: { text: 'hi' },
    ttlMs: 10_000,
  };

  it('accepts a well-formed message', () => {
    expect(clientMessageSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a wrong protocol version', () => {
    const result = clientMessageSchema.safeParse({ ...valid, v: 2 });
    expect(result.success).toBe(false);
  });

  it('rejects ttl outside the allowed window', () => {
    expect(clientMessageSchema.safeParse({ ...valid, ttlMs: 100 }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ ...valid, ttlMs: 120_000 }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ ...valid, ttlMs: LIMITS.minTtlMs }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ ...valid, ttlMs: LIMITS.maxTtlMs }).success).toBe(true);
  });

  it('rejects an unknown op and a missing payload', () => {
    expect(clientFrameSchema.safeParse({ ...valid, op: 'SUBSCRIBE' }).success).toBe(false);
    const withoutPayload = { ...valid } as Record<string, unknown>;
    delete withoutPayload.payload;
    expect(clientMessageSchema.safeParse(withoutPayload).success).toBe(false);
  });

  it('accepts PING frames', () => {
    expect(clientFrameSchema.safeParse({ v: 1, id: 'p1', op: 'PING' }).success).toBe(true);
  });
});

describe('server frames and helpers', () => {
  it('builds ACKs with and without recipients', () => {
    const accepted = ackFrame('msg-1', 'accepted');
    expect(accepted.op).toBe('ACK');
    expect(accepted.replyTo).toBe('msg-1');
    expect(accepted.payload).toEqual({ status: 'accepted' });

    const delivered = ackFrame('msg-1', 'delivered', { recipients: 2 });
    expect(delivered.payload.recipients).toBe(2);
  });

  it('builds error frames with a stable shape', () => {
    const frame = errorFrame('TYPE_DENIED', 'nope', 'msg-1');
    expect(frame.payload).toEqual({ code: 'TYPE_DENIED', message: 'nope' });
    expect(frame.replyTo).toBe('msg-1');
  });

  it('computes absolute expiry from the server clock', () => {
    expect(computeExpireAt(1_000, undefined)).toBe(1_000 + LIMITS.defaultTtlMs);
    expect(computeExpireAt(1_000, 5_000)).toBe(6_000);
  });

  it('namespaces dedupe and presence keys per sender/instance', () => {
    expect(dedupeKey('user-1', 'msg-1')).toBe('irc:dedupe:user-1:msg-1');
    expect(dedupeKey('user-1', 'msg-1')).not.toBe(dedupeKey('user-2', 'msg-1'));
    expect(presenceKeys.connection('c1')).toBe('irc:presence:conn:c1');
    expect(presenceKeys.userConnections('u1')).toBe('irc:presence:user:u1');
    expect(presenceKeys.instanceConnections('n1')).toBe('irc:presence:instance:n1');
    expect(sessionRevokedKey('s1')).toBe('auth:session:revoked:s1');
  });
});
