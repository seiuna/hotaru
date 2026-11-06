import { loadConfig } from './config/env.js';
import { buildApp } from './app.js';
import { connectMongo, disconnectMongo } from './infrastructure/mongo/connection.js';
import { ensureIndexes } from './infrastructure/mongo/indexes.js';
import { createRedis, closeRedis } from './infrastructure/redis/client.js';
import { initKeys } from './infrastructure/crypto/keys.js';
import type { AppContext } from './context.js';

async function main(): Promise<void> {
  const config = loadConfig();

  await connectMongo(config);
  if (config.ensureIndexes) {
    // Unique constraints are correctness requirements (users.minecraftUuid,
    // permissions(userId,scope), refresh_tokens.tokenHash), so a fresh database
    // must get them before it takes traffic.
    await ensureIndexes();
  }
  const redis = createRedis(config);
  const keys = await initKeys(config);

  const ctx: AppContext = { config, keys, redis };
  const app = await buildApp(ctx);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
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
    { issuer: config.jwtIssuer, audience: config.jwtAudience },
    'mc auth platform ready',
  );
}

main().catch((error: unknown) => {
  // Config/DB/Redis failures are fatal: never serve auth with a broken backend.
  console.error('[fatal] failed to start auth-server:', error);
  process.exit(1);
});
