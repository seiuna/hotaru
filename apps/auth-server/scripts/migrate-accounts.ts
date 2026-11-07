/**
 * One-time account migration.
 *
 * - Replaces the old non-partial unique indexes on users.minecraftUuid and
 *   users.loginName with partial unique indexes, so account-only rows (no UUID,
 *   no login name) do not collide on null.
 * - Creates minecraft_links rows for legacy MC-only users.
 *
 * Run with: pnpm --filter @hotaru/auth-server migrate:accounts
 */
import { loadConfig } from '../src/config/env.js';
import { connectMongo, disconnectMongo } from '../src/infrastructure/mongo/connection.js';
import {
  MinecraftLinkModel,
  UserModel,
} from '../src/infrastructure/mongo/models/index.js';

async function main(): Promise<void> {
  const config = loadConfig();
  await connectMongo(config);

  try {
    await UserModel.syncIndexes();

    const users = await UserModel.find({
      minecraftUuid: { $type: 'string' },
    })
      .select({ _id: 1, minecraftUuid: 1, username: 1 })
      .lean();

    let created = 0;
    for (const user of users) {
      if (!user.minecraftUuid) continue;
      const now = new Date();
      const result = await MinecraftLinkModel.updateOne(
        { minecraftUuid: user.minecraftUuid },
        {
          $setOnInsert: {
            accountId: user._id,
            minecraftUuid: user.minecraftUuid,
            minecraftUsername: user.username,
            status: 'active',
            verifiedAt: now,
            linkedAt: now,
          },
        },
        { upsert: true },
      );
      if (result.upsertedCount > 0) created += 1;
    }

    console.log(`[migrate-accounts] users=${users.length} links_created=${created}`);
  } finally {
    await disconnectMongo();
  }
}

main().catch((error: unknown) => {
  console.error('[migrate-accounts] failed:', error);
  process.exit(1);
});
