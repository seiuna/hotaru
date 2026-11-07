import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../config/env.js';
import type { AppContext } from '../../context.js';
import type {
  AuditService,
  FilterService,
  GroupService,
  GroupMembership,
} from '../../runtime/contracts.js';
import type { DedupeStore } from '../../runtime/dedupe.js';
import type { ConnectionRegistry } from '../../runtime/contracts.js';
import type { ManagedConnection } from '../../runtime/registry.js';
import { handleMessageFrame } from './index.js';

const USER_UUID = '4c1099df-e202-4e64-9ea2-9039be420143';
const OTHER_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function config(): AppConfig {
  return {
    adminUuids: [],
    broadcastEnabled: true,
    maxPayloadBytes: 65536,
  } as unknown as AppConfig;
}

function ctx(): AppContext {
  return {
    config: config(),
    redis: {} as AppContext['redis'],
    instanceId: 'test',
    now: () => 1_000,
  };
}

function connection(overrides: Partial<ManagedConnection> = {}): ManagedConnection {
  return {
    connectionId: 'conn-a',
    userId: 'user-a',
    minecraftUuid: USER_UUID,
    instanceId: 'test',
    connectedAt: 0,
    lastHeartbeatAt: 0,
    isOpen: true,
    scopes: ['hotaru:ircserver'],
    socket: {} as ManagedConnection['socket'],
    pongTimer: null,
    ip: null,
    userAgent: null,
    send: () => true,
    close: () => {},
    ...overrides,
  } as ManagedConnection;
}

function filters(overrides: Partial<FilterService> = {}): FilterService {
  return {
    isGloballyDenied: vi.fn().mockResolvedValue(false),
    isGroupDenied: vi.fn().mockResolvedValue(false),
    isUserDenied: vi.fn().mockResolvedValue(false),
    listRules: vi.fn().mockResolvedValue([]),
    replaceRules: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function groups(overrides: Partial<GroupService> = {}): GroupService {
  return {
    createGroup: vi.fn(),
    listGroupsForUser: vi.fn().mockResolvedValue([]),
    getGroup: vi.fn(),
    updateGroup: vi.fn(),
    deleteGroup: vi.fn(),
    addMember: vi.fn(),
    removeMember: vi.fn(),
    setMemberRole: vi.fn(),
    membership: vi.fn().mockResolvedValue(null),
    memberUuids: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as GroupService;
}

function dedupe(status: 'new' | 'duplicate-same' | 'duplicate-different' = 'new'): DedupeStore {
  return { begin: vi.fn().mockResolvedValue({ status }) } as unknown as DedupeStore;
}

function registry(handles: ManagedConnection[] = []): ConnectionRegistry {
  return {
    listByUser: (uuid: string) => handles.filter((handle) => handle.minecraftUuid === uuid),
    listAll: () => handles,
    get: () => undefined,
    count: () => handles.length,
    onlineUuids: () => [],
  };
}

const audit: AuditService = { record: vi.fn().mockResolvedValue(undefined) };

function baseDeps(overrides: Partial<Parameters<typeof handleMessageFrame>[0]> = {}) {
  return {
    ctx: ctx(),
    registry: registry([]),
    dispatcher: {
      deliverToUser: vi.fn().mockReturnValue(0),
      deliverToConnections: vi.fn().mockReturnValue(0),
      broadcast: vi.fn().mockReturnValue(0),
    },
    groups: groups(),
    filters: filters(),
    dedupe: dedupe(),
    audit,
    ...overrides,
  };
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    v: 1 as const,
    id: 'msg-1',
    op: 'MESSAGE' as const,
    type: 'chat.message',
    route: { mode: 'DIRECT' as const, target: OTHER_UUID },
    payload: { text: 'hi' },
    ...overrides,
  };
}

describe('handleMessageFrame', () => {
  it('sends accepted then failed TARGET_OFFLINE for an offline direct target', async () => {
    const frames: unknown[] = [];
    await handleMessageFrame(baseDeps(), connection(), message(), (frame) => frames.push(frame));

    expect(frames).toHaveLength(2);
    expect((frames[0] as { op: string }).op).toBe('ACK');
    expect((frames[0] as { payload: { status: string } }).payload.status).toBe('accepted');
    expect((frames[1] as { payload: { status: string; reason: string } }).payload).toEqual({
      status: 'failed',
      reason: 'TARGET_OFFLINE',
    });
  });

  it('delivers to online connections and reports recipients', async () => {
    const target = connection({ connectionId: 'conn-b', userId: 'user-b', minecraftUuid: OTHER_UUID });
    const deps = baseDeps({
      registry: registry([target]),
      dispatcher: {
        deliverToUser: vi.fn(),
        deliverToConnections: vi.fn().mockReturnValue(1),
        broadcast: vi.fn(),
      },
    });
    const frames: Array<{ payload: { status: string; recipients?: number } }> = [];
    await handleMessageFrame(deps, connection(), message(), (frame) =>
      frames.push(frame as { payload: { status: string; recipients?: number } }),
    );

    expect(frames.map((frame) => frame.payload.status)).toEqual(['accepted', 'delivered']);
    expect(frames[1]?.payload.recipients).toBe(1);
    expect(deps.dispatcher.deliverToConnections).toHaveBeenCalledOnce();
  });

  it('rejects a globally denied type before routing', async () => {
    const frames: unknown[] = [];
    await handleMessageFrame(
      baseDeps({ filters: filters({ isGloballyDenied: vi.fn().mockResolvedValue(true) }) }),
      connection(),
      message(),
      (frame) => frames.push(frame),
    );
    expect(frames).toHaveLength(1);
    expect((frames[0] as { payload: { status: string; reason: string } }).payload).toEqual({
      status: 'failed',
      reason: 'TYPE_DENIED',
    });
  });

  it('refuses an invalid type with an ERROR frame', async () => {
    const frames: Array<{ op: string; payload: { code?: string } }> = [];
    await handleMessageFrame(baseDeps(), connection(), message({ type: 'srp.steal' }), (frame) =>
      frames.push(frame as { op: string; payload: { code?: string } }),
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]?.op).toBe('ERROR');
    expect(frames[0]?.payload.code).toBe('INVALID_TYPE');
  });

  it('acknowledges a replay without fan-out', async () => {
    const deps = baseDeps({ dedupe: dedupe('duplicate-same') });
    const frames: Array<{ payload: { status: string } }> = [];
    await handleMessageFrame(deps, connection(), message(), (frame) =>
      frames.push(frame as { payload: { status: string } }),
    );
    expect(frames.map((frame) => frame.payload.status)).toEqual(['accepted']);
    expect(deps.dispatcher.deliverToConnections).not.toHaveBeenCalled();
  });

  it('refuses a duplicate id with a different payload', async () => {
    const frames: Array<{ payload: { status: string; reason: string } }> = [];
    await handleMessageFrame(baseDeps({ dedupe: dedupe('duplicate-different') }), connection(), message(), (frame) =>
      frames.push(frame as { payload: { status: string; reason: string } }),
    );
    expect(frames[0]?.payload).toEqual({ status: 'failed', reason: 'DUPLICATE_MESSAGE_ID' });
  });

  it('routes a group message to members except the sender', async () => {
    const membership: GroupMembership = {
      groupId: 'grp_1',
      userUuid: USER_UUID,
      role: 'MEMBER',
      joinedAt: '2026-01-01T00:00:00.000Z',
    };
    const other = connection({ connectionId: 'conn-b', userId: 'user-b', minecraftUuid: OTHER_UUID });
    const deps = baseDeps({
      registry: registry([other]),
      groups: groups({
        membership: vi.fn().mockResolvedValue(membership),
        memberUuids: vi.fn().mockResolvedValue([USER_UUID, OTHER_UUID]),
      }),
      dispatcher: {
        deliverToUser: vi.fn(),
        deliverToConnections: vi.fn().mockReturnValue(1),
        broadcast: vi.fn(),
      },
    });
    const frames: Array<{ payload: { status: string; recipients?: number } }> = [];
    await handleMessageFrame(
      deps,
      connection(),
      message({ route: { mode: 'GROUP', target: 'grp_1' } }),
      (frame) => frames.push(frame as { payload: { status: string; recipients?: number } }),
    );

    expect(frames.map((frame) => frame.payload.status)).toEqual(['accepted', 'delivered']);
    const delivered = (deps.dispatcher.deliverToConnections as ReturnType<typeof vi.fn>).mock.calls[0];
    const targets = delivered?.[0] as ManagedConnection[];
    expect(targets.map((target) => target.minecraftUuid)).toEqual([OTHER_UUID]);
  });

  it('denies a group message when the sender is not a member', async () => {
    const frames: Array<{ payload: { status: string; reason: string } }> = [];
    await handleMessageFrame(
      baseDeps(),
      connection(),
      message({ route: { mode: 'GROUP', target: 'grp_missing' } }),
      (frame) => frames.push(frame as { payload: { status: string; reason: string } }),
    );
    expect(frames[1]?.payload).toEqual({ status: 'failed', reason: 'GROUP_ACCESS_DENIED' });
  });

  it('denies broadcast without the scope or admin uuid', async () => {
    const frames: Array<{ payload: { status: string; reason: string } }> = [];
    await handleMessageFrame(
      baseDeps(),
      connection(),
      message({ route: { mode: 'BROADCAST', target: null } }),
      (frame) => frames.push(frame as { payload: { status: string; reason: string } }),
    );
    expect(frames[1]?.payload).toEqual({ status: 'failed', reason: 'BROADCAST_DENIED' });
  });

  it('delivers an expired message as MESSAGE_EXPIRED', async () => {
    // The clock must advance between acceptance and delivery for a message to expire.
    let clock = 1_000;
    const deps = baseDeps();
    deps.ctx = { ...deps.ctx, now: () => clock };
    const frames: Array<{ payload: { status: string; reason?: string } }> = [];

    await handleMessageFrame(deps, connection(), message({ ttlMs: 1_000 }), (frame) => {
      frames.push(frame as { payload: { status: string; reason?: string } });
      // Time passes while the message is queued for fan-out.
      clock = 9_000;
    });

    expect(frames.some((frame) => frame.payload.reason === 'MESSAGE_EXPIRED')).toBe(true);
  });
});
