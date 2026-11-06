import { loadConfig } from './config/env.js';
import { buildApp } from './app.js';
import { connectMongo, disconnectMongo } from './infrastructure/mongo/connection.js';
import { ensureIndexes } from './infrastructure/mongo/indexes.js';
import { createRedis, closeRedis } from './infrastructure/redis/client.js';
import { createRuntime } from './runtime/index.js';
import type { AppContext } from './context.js';

async function main(): Promise<void> {
  const config = loadConfig();
  await connectMongo(config);
  // Unique constraints (memberships, filter rules) are correctness requirements.
  if (config.ensureIndexes) await ensureIndexes();
  const redis = createRedis(config);

  const ctx: AppContext = {
    config,
    redis,
    instanceId: config.instanceId,
    now: () => Date.now(),
  };

  const runtime = createRuntime(ctx);
  const { app, ws } = await buildApp(ctx, runtime);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      // Stop accepting new sockets, let in-flight frames settle, then drop clients
      // so they can reconnect to a healthy node.
      await ws.close();
      await app.close();
      await closeRedis();
      await disconnectMongo();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'shutdown failed');
      process.exit(1);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void shutdown(signal));
  }

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      instanceId: config.instanceId,
      wsEndpoint: `/v1/connect`,
      jwks: config.authJwksUrl,
      heartbeatMs: config.heartbeatIntervalMs,
    },
    'SRP v1 IRC server ready',
  );
}

main().catch((error: unknown) => {
  console.error('[fatal] failed to start irc-server:', error);
  process.exit(1);
});
