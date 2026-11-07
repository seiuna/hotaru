import { createServer } from 'node:http';
import { APP_NAME, healthPayload } from '@hotaru/shared';

const PORT = Number(process.env.PORT ?? 3000);
const startedAt = Date.now();

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(healthPayload(`${APP_NAME}-api`, startedAt)));
    return;
  }

  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ message: `Hello from ${APP_NAME}-api`, path: url.pathname }));
});

server.listen(PORT, () => {
  console.log(`[${APP_NAME}-api] listening on http://localhost:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[${APP_NAME}-api] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
  });
}
