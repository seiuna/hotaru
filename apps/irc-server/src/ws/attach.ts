import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  clientFrameSchema,
  errorFrame,
  pongFrame,
  readyFrame,
  type ClientMessage,
} from '@hotaru/srp-protocol';
import { AuthError, verifyAccessToken } from '../infrastructure/auth/verify-token.js';
import { clientIp } from '../http/zod-schema.js';
import type { InMemoryRegistry, ManagedConnection } from '../runtime/registry.js';
import type { PresenceStore } from '../runtime/presence.js';
import { TokenBucket } from '../runtime/rate-limit.js';
import { handleMessageFrame, type RoutingDeps } from '../modules/routing/index.js';

export const CONNECT_PATH = '/v1/connect';

export interface WebSocketDeps extends RoutingDeps {
  presence: PresenceStore;
  registry: InMemoryRegistry;
}

export interface WebSocketHandle {
  /** Closes all sockets (1001) and stops timers; safe to call twice. */
  close(): Promise<void>;
  connectionCount(): number;
}

/**
 * Attaches the SRP v1 WebSocket endpoint to the Fastify HTTP server.
 *
 * Authentication happens during the HTTP upgrade, before a single frame is read:
 * an invalid/expired/revoked token or a missing `hotaru:ircserver` scope gets
 * a plain HTTP 401/403 with an `error.code`, exactly like the REST API.
 */
export function attachWebSocket(app: FastifyInstance, deps: WebSocketDeps): WebSocketHandle {
  const { ctx } = deps;
  const registry: InMemoryRegistry = deps.registry;
  const wss = new WebSocketServer({ noServer: true, maxPayload: ctx.config.maxFrameBytes });
  const buckets = new Map<string, TokenBucket>();
  const groupBuckets = new Map<string, TokenBucket>();
  const heartbeatTimers = new Set<ReturnType<typeof setInterval>>();
  let closed = false;

  const reject = (socket: Duplex, status: number, code: string, message: string): void => {
    const body = JSON.stringify({ error: { code, message } });
    socket.write(
      `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Service Unavailable'}\r\n` +
        'content-type: application/json\r\n' +
        'connection: close\r\n' +
        `content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    socket.destroy();
  };

  const onUpgrade = async (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname !== CONNECT_PATH) {
      reject(socket, 404, 'NOT_FOUND', 'Unknown WebSocket endpoint');
      return;
    }

    const header = request.headers.authorization;
    const token = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    if (!token) {
      reject(socket, 401, 'UNAUTHORIZED', 'Authorization: Bearer <access token> is required');
      return;
    }

    let identity;
    try {
      identity = await verifyAccessToken(ctx, token);
    } catch (error) {
      const authError = error instanceof AuthError ? error : null;
      reject(
        socket,
        authError?.statusCode ?? 401,
        authError?.code ?? 'UNAUTHORIZED',
        authError?.message ?? 'Access token is invalid',
      );
      return;
    }

    if (registry.count() >= ctx.config.maxConnectionsTotal) {
      reject(socket, 503, 'RATE_LIMITED', 'Server is at capacity');
      return;
    }
    if (registry.listByUser(identity.minecraftUuid).length >= ctx.config.maxConnectionsPerUser) {
      reject(socket, 429, 'RATE_LIMITED', 'Too many connections for this account');
      return;
    }
    const ip = clientIp(request.headers as Record<string, unknown>, request.socket.remoteAddress ?? '');
    if (ip && registry.connectionsFromIp(ip) >= ctx.config.maxConnectionsPerIp) {
      reject(socket, 429, 'RATE_LIMITED', 'Too many connections from this address');
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, identity, ip);
    });
  };

  app.server.on('upgrade', (request, socket, head) => {
    // Node emits 'upgrade' for ANY Upgrade header, including HTTP/2's h2c upgrade
    // that java.net.http sends by default over cleartext HTTP. Only WebSocket
    // upgrades are ours; destroying the socket for anything else is honest, while
    // answering 404 'Unknown WebSocket endpoint' to a REST client is not.
    const upgrade = String(request.headers.upgrade ?? '').toLowerCase();
    if (upgrade !== 'websocket') {
      app.log.debug({ upgrade, url: request.url }, 'ignoring non-websocket upgrade');
      socket.destroy();
      return;
    }
    void onUpgrade(request, socket, head);
  });

  wss.on(
    'connection',
    (
      socket: WebSocket,
      request: IncomingMessage,
      identity: Awaited<ReturnType<typeof verifyAccessToken>>,
      ip: string | null,
    ) => {
      const connectionId = randomUUID();
      const connection: ManagedConnection = {
        connectionId,
        userId: identity.userId,
        minecraftUuid: identity.minecraftUuid,
        instanceId: ctx.instanceId,
        connectedAt: ctx.now(),
        lastHeartbeatAt: ctx.now(),
        isOpen: true,
        scopes: identity.scopes,
        socket,
        pongTimer: null,
        ip,
        userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
        send: (frame: unknown) => sendFrame(connection, frame),
        close: (reason: string) => socket.close(1000, reason.slice(0, 120)),
      };

      registry.add(connection);
      buckets.set(connectionId, new TokenBucket(ctx.config.messageRatePerSec, ctx.config.messageBurst));
      groupBuckets.set(
        connectionId,
        new TokenBucket(ctx.config.groupMessageRatePerSec, ctx.config.groupMessageRatePerSec * 2),
      );

      void deps.presence.register(connection).catch(() => {
        /* presence is best-effort; the local registry is authoritative here */
      });

      socket.on('pong', () => {
        connection.lastHeartbeatAt = ctx.now();
        if (connection.pongTimer) {
          clearTimeout(connection.pongTimer);
          connection.pongTimer = null;
        }
        void deps.presence.touch(connection).catch(() => {});
      });

      socket.on('message', (raw) => {
        void onClientFrame(connection, raw.toString());
      });

      socket.on('close', () => {
        connection.isOpen = false;
        if (connection.pongTimer) clearTimeout(connection.pongTimer);
        registry.remove(connectionId);
        buckets.delete(connectionId);
        groupBuckets.delete(connectionId);
        void deps.presence.unregister(connection).catch(() => {});
      });

      socket.on('error', () => {
        /* 'close' follows and does the cleanup */
      });

      sendFrame(
        connection,
        readyFrame({
          connectionId,
          userId: connection.userId,
          minecraftUuid: connection.minecraftUuid,
          instanceId: ctx.instanceId,
          heartbeatIntervalMs: ctx.config.heartbeatIntervalMs,
          serverTime: ctx.now(),
        }),
      );
    },
  );

  const heartbeat = setInterval(() => {
    for (const connection of registry.listAll()) {
      if (!connection.isOpen) continue;
      if (connection.socket.readyState !== connection.socket.OPEN) continue;
      try {
        connection.socket.ping();
      } catch {
        /* the close handler will clean up */
      }
      if (connection.pongTimer) clearTimeout(connection.pongTimer);
      connection.pongTimer = setTimeout(() => {
        // No pong inside the window: the peer is dead even if TCP has not noticed.
        connection.socket.terminate();
      }, ctx.config.pongTimeoutMs);
    }
  }, ctx.config.heartbeatIntervalMs);
  heartbeatTimers.add(heartbeat);

  const sweeper = setInterval(() => {
    void deps.presence.prune().catch(() => {});
  }, Math.max(30_000, Math.floor(ctx.config.presenceTtlMs / 2)));
  heartbeatTimers.add(sweeper);

  /** Writes a frame and enforces the slow-client budget. */
  function sendFrame(connection: ManagedConnection, frame: unknown): boolean {
    const socket = connection.socket;
    if (socket.readyState !== socket.OPEN) return false;
    if (socket.bufferedAmount > ctx.config.maxWsBufferedBytes) {
      // A client that cannot keep up must not make the server buffer unboundedly.
      app.log.warn({ connectionId: connection.connectionId, buffered: socket.bufferedAmount }, 'closing slow client');
      socket.close(1013, 'backpressure');
      return false;
    }
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  async function onClientFrame(connection: ManagedConnection, raw: string): Promise<void> {
    if (!connection.isOpen) return;
    if (Buffer.byteLength(raw, 'utf8') > ctx.config.maxFrameBytes) {
      sendFrame(connection, errorFrame('PAYLOAD_TOO_LARGE', 'Frame exceeds the size limit'));
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendFrame(connection, errorFrame('INVALID_ENVELOPE', 'Frame is not valid JSON'));
      return;
    }

    const frame = clientFrameSchema.safeParse(parsed);
    if (!frame.success) {
      const version = (parsed as { v?: unknown } | null)?.v;
      if (version !== undefined && version !== 1) {
        sendFrame(connection, errorFrame('UNSUPPORTED_VERSION', 'Only protocol version 1 is supported'));
        return;
      }
      sendFrame(
        connection,
        errorFrame('INVALID_ENVELOPE', frame.error.issues[0]?.message ?? 'Invalid envelope'),
      );
      return;
    }

    if (frame.data.op === 'PING') {
      sendFrame(connection, pongFrame(frame.data.id));
      return;
    }

    const message = frame.data as ClientMessage;

    // Business payload budget, enforced before any routing work happens.
    const payloadBytes = Buffer.byteLength(JSON.stringify(message.payload ?? null), 'utf8');
    if (payloadBytes > ctx.config.maxPayloadBytes) {
      sendFrame(connection, errorFrame('PAYLOAD_TOO_LARGE', `Payload exceeds ${ctx.config.maxPayloadBytes} bytes`, message.id));
      sendFrame(connection, {
        v: 1,
        id: `ack_${Date.now().toString(36)}`,
        op: 'ACK',
        type: 'protocol.ack',
        replyTo: message.id,
        payload: { status: 'failed', reason: 'PAYLOAD_TOO_LARGE' },
      });
      return;
    }

    const isGroup = message.route.mode === 'GROUP';
    const bucket = isGroup ? groupBuckets.get(connection.connectionId) : buckets.get(connection.connectionId);
    if (!bucket || !bucket.tryConsume()) {
      const retryAfter = bucket?.retryAfterSeconds() ?? 1;
      sendFrame(connection, errorFrame('RATE_LIMITED', `Slow down; retry in ${retryAfter}s`, message.id));
      sendFrame(connection, {
        v: 1,
        id: `ack_${Date.now().toString(36)}`,
        op: 'ACK',
        type: 'protocol.ack',
        replyTo: message.id,
        payload: { status: 'failed', reason: 'RATE_LIMITED' },
      });
      return;
    }

    try {
      await handleMessageFrame(deps, connection, message, (out) => {
        sendFrame(connection, out);
      });
    } catch (error) {
      // A failing dependency must never leave the client without an answer.
      app.log.error({ err: error, connectionId: connection.connectionId }, 'message handling failed');
      sendFrame(connection, errorFrame('INTERNAL_ERROR', 'The server could not process this message', message.id));
      sendFrame(connection, {
        v: 1,
        id: `ack_${Date.now().toString(36)}`,
        op: 'ACK',
        type: 'protocol.ack',
        replyTo: message.id,
        payload: { status: 'failed', reason: 'INTERNAL_ERROR' },
      });
    }
  }

  return {
    connectionCount: () => registry.count(),
    async close() {
      if (closed) return;
      closed = true;
      for (const timer of heartbeatTimers) clearInterval(timer);
      heartbeatTimers.clear();
      for (const connection of registry.listAll()) {
        try {
          connection.socket.close(1001, 'server shutting down');
        } catch {
          /* ignore */
        }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
