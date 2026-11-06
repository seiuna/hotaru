import { createServer } from 'node:http';

/**
 * Minimal stand-in for Mojang's session server, used by the end-to-end smoke
 * test. It implements exactly the two endpoints the protocol needs, and it is
 * deliberately strict: `hasJoined` only answers 200 when the *exact* server hash
 * the client posted to `join` matches the one the auth server asks about. That
 * is what proves both sides computed the vanilla hash identically.
 */
export function startFakeMojang({ port = 8787, log = () => {} } = {}) {
  /** @type {Map<string, { uuid: string, username: string }>} */
  const joined = new Map();
  /** @type {Array<{ type: string, body?: unknown }>} */
  const calls = [];
  let outage = false;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'POST' && url.pathname === '/session/minecraft/join') {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        try {
          const body = JSON.parse(raw);
          calls.push({ type: 'join', body });
          if (!body?.accessToken || !body?.selectedProfile || !body?.serverId) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'IllegalArgumentException', errorMessage: 'bad join' }));
            return;
          }
          // Test-only convention: the fake access token carries the identity.
          const [uuidHex, username] = String(body.accessToken).split('.');
          joined.set(body.serverId, { uuid: uuidHex, username });
          log(`[fake-mojang] join accepted for ${username} hash=${body.serverId}`);
          res.writeHead(204);
          res.end();
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/session/minecraft/hasJoined') {
      const username = url.searchParams.get('username') ?? '';
      const serverId = url.searchParams.get('serverId') ?? '';
      calls.push({ type: 'hasJoined', body: { username, serverId } });
      if (outage) {
        log('[fake-mojang] simulated outage (503)');
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'simulated outage' }));
        return;
      }
      const record = joined.get(serverId);
      if (record && record.username.toLowerCase() === username.toLowerCase()) {
        log(`[fake-mojang] hasJoined confirmed ${username}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: record.uuid, name: record.username }));
        return;
      }
      log(`[fake-mojang] hasJoined denied ${username} hash=${serverId}`);
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  return {
    calls,
    joined,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : port;
      return `http://127.0.0.1:${boundPort}`;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
    /** Forces the next hasJoined for this hash to answer 503 (outage simulation). */
    joinedCount() {
      return joined.size;
    },
    setOutage(value) {
      outage = Boolean(value);
    },
  };
}
