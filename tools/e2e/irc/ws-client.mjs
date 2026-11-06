/**
 * SRP v1 client helpers for the IRC end-to-end harness.
 *
 * The harness talks to the real server over a real WebSocket, so it needs a
 * client that can put `Authorization: Bearer <JWT>` on the *upgrade request* —
 * the WHATWG `WebSocket` constructor cannot do that, and the repo does not
 * depend on `ws` at the root. Resolution order:
 *
 *   1. `ws` if it is resolvable from the repo root;
 *   2. `ws` from apps/irc-server's own node_modules (pnpm does not hoist);
 *   3. Node 24's built-in `WebSocket`, which accepts a non-standard
 *      `{ headers }` second argument (verified on Node 24.20).
 *
 * Negative upgrade tests never rely on the client library: they speak the HTTP
 * upgrade handshake directly (`probeUpgrade`) so the assertion is on the real
 * status line and error body the server writes before a socket ever exists.
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..', '..', '..');

/** Thrown by `probeUpgrade` when the server answers the upgrade with non-101. */
export class UpgradeRejected extends Error {
  constructor(statusCode, body) {
    super(`upgrade rejected with HTTP ${statusCode}`);
    this.name = 'UpgradeRejected';
    this.statusCode = statusCode;
    this.body = body;
  }
}

function pickWebSocket(mod) {
  const candidate = mod?.WebSocket ?? mod?.default?.WebSocket ?? mod?.default;
  return typeof candidate === 'function' ? candidate : null;
}

/**
 * Resolves a WebSocket constructor. Returns `{ C, source }` so the harness can
 * report which client it actually used instead of assuming.
 */
export async function loadWebSocket() {
  try {
    const mod = await import('ws');
    const C = pickWebSocket(mod);
    if (C) return { C, source: 'ws' };
  } catch {
    /* not a root dependency */
  }
  try {
    const require = createRequire(path.join(repoRoot, 'apps', 'irc-server', 'package.json'));
    const mod = await import(pathToFileURL(require.resolve('ws')).href);
    const C = pickWebSocket(mod);
    if (C) return { C, source: 'ws (apps/irc-server)' };
  } catch {
    /* fall through to the built-in */
  }
  const C = globalThis.WebSocket;
  if (typeof C === 'function') return { C, source: 'node built-in WebSocket' };
  throw new Error('No WebSocket client available (install ws or use Node >= 22)');
}

/** Decodes a JWT payload without verifying it (test-side inspection only). */
export function decodeJwtPayload(token) {
  const [, payload] = String(token).split('.');
  if (!payload) return null;
  const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Performs the HTTP upgrade handshake by hand and reports the status code.
 * A successful upgrade resolves with `{ status: 101, upgraded: true }`.
 */
export function probeUpgrade({ url, token, headers = {}, timeoutMs = 8000 }) {
  const target = new URL(url);
  const secure = target.protocol === 'wss:';
  const lib = secure ? https : http;
  const requestHeaders = {
    connection: 'Upgrade',
    upgrade: 'websocket',
    'sec-websocket-version': '13',
    'sec-websocket-key': randomBytes(16).toString('base64'),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...headers,
  };

  return new Promise((resolve, reject) => {
    const request = lib.request(
      {
        protocol: secure ? 'https:' : 'http:',
        hostname: target.hostname,
        port: target.port || (secure ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: requestHeaders,
        timeout: timeoutMs,
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
        response.on('error', (error) => reject(error));
      },
    );
    request.on('upgrade', (response, socket) => {
      socket.destroy();
      resolve({ status: response.statusCode, headers: response.headers, body: '', upgraded: true });
    });
    request.on('timeout', () => request.destroy(new Error(`upgrade probe timed out after ${timeoutMs}ms`)));
    request.on('error', (error) => reject(error));
    request.end();
  });
}

/**
 * A single SRP connection with a frame buffer.
 *
 * Frames arrive interleaved (READY, ACK accepted, ACK delivered, ERROR, ...), so
 * every wait is a predicate over the ordered buffer: `waitFor` takes the first
 * matching frame and leaves the rest in place for later assertions.
 */
export class SrpClient {
  constructor(socket, { label, impl }) {
    this.socket = socket;
    this.label = label;
    this.impl = impl;
    this.frames = [];
    this.waiters = [];
    this.closed = null;
    this.raw = '';
    /** Optional hook for hot-path consumers (load.mjs) that must not buffer. */
    this.onFrame = null;
  }

  static async connect({ url, token, headers = {}, timeoutMs = 8000, WebSocketImpl, label = 'client' }) {
    const WS = WebSocketImpl ?? (await loadWebSocket()).C;
    const upgradeHeaders = {
      'user-agent': 'skymatrix-srp-e2e/1',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    };
    const socket = new WS(url, { headers: upgradeHeaders });
    const client = new SrpClient(socket, { label, impl: 'ws' });

    socket.addEventListener('message', (event) => {
      const text = typeof event.data === 'string' ? event.data : String(event.data);
      client.raw = text;
      let frame;
      try {
        frame = JSON.parse(text);
      } catch {
        frame = { _unparsed: text };
      }
      client._onFrame(frame);
    });
    socket.addEventListener('close', (event) => {
      client.closed = { code: event.code, reason: event.reason };
      client._rejectWaiters(new Error(`${label} closed (${event.code} ${event.reason ?? ''})`));
    });
    socket.addEventListener('error', () => {
      /* the close event carries the code; connection errors surface via connect() */
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label}: connect timed out after ${timeoutMs}ms`)), timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener('error', (event) => {
        clearTimeout(timer);
        reject(new Error(`${label}: connect failed: ${event?.message ?? 'socket error'}`));
      });
    }).catch((error) => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      throw error;
    });

    return client;
  }

  get isOpen() {
    return this.socket.readyState === 1;
  }

  send(frame) {
    this.socket.send(JSON.stringify(frame));
  }

  _onFrame(frame) {
    if (this.onFrame) {
      try {
        this.onFrame(frame);
      } catch {
        /* a broken observer must not break the socket bookkeeping */
      }
    }
    // A frame that satisfies a pending waiter belongs to that waiter only: it is
    // resolved directly and never also buffered, otherwise the next wait would
    // match the same frame again.
    for (const waiter of [...this.waiters]) {
      let matched = false;
      try {
        matched = waiter.predicate(frame);
      } catch {
        matched = false;
      }
      if (matched) {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        waiter.resolve(frame);
        return;
      }
    }
    this.frames.push(frame);
  }

  _rejectWaiters(error) {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  /** Removes and returns the first buffered frame matching `predicate`. */
  take(predicate) {
    for (let index = 0; index < this.frames.length; index += 1) {
      let matched = false;
      try {
        matched = predicate(this.frames[index]);
      } catch {
        matched = false;
      }
      if (matched) return this.frames.splice(index, 1)[0];
    }
    return null;
  }

  /** Waits for the next frame matching `predicate` (buffer first, then socket). */
  waitFor(predicate, { timeoutMs = 5000, describe = 'frame' } = {}) {
    const buffered = this.take(predicate);
    if (buffered) return Promise.resolve(buffered);
    if (this.closed) {
      return Promise.reject(new Error(`${this.label}: socket already closed (${this.closed.code}) while waiting for ${describe}`));
    }
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve: null, reject: null };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        reject(
          new Error(
            `${this.label}: timed out after ${timeoutMs}ms waiting for ${describe}; buffered: ${this.describeFrames()}`,
          ),
        );
      }, timeoutMs);
      waiter.resolve = (frame) => {
        clearTimeout(timer);
        resolve(frame);
      };
      waiter.reject = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      this.waiters.push(waiter);
    });
  }

  waitForOp(op, extra = {}, options = {}) {
    return this.waitFor(
      (frame) => frame?.op === op && Object.entries(extra).every(([key, value]) => frame[key] === value),
      { describe: `${op}${Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ''}`, ...options },
    );
  }

  /** Reads everything already buffered without waiting. */
  drain() {
    return this.frames.splice(0, this.frames.length);
  }

  describeFrames() {
    if (this.frames.length === 0) return '(none)';
    return this.frames
      .map((frame) => `${frame?.op ?? '?'}${frame?.type ? `/${frame.type}` : ''}${frame?.replyTo ? `->${frame.replyTo}` : ''}`)
      .join(', ');
  }

  async close(code = 1000) {
    if (!this.isOpen) return;
    try {
      this.socket.close(code);
    } catch {
      /* ignore */
    }
  }
}

/** Sleeps, then returns whatever was buffered (used to prove "nothing arrived"). */
export async function settle(client, ms = 300) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return client.frames.slice();
}
