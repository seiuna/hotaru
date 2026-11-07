/**
 * Creates a linked Minecraft account for local e2e harnesses.
 *
 *   pnpm --filter @hotaru/auth-server seed:player -- --uuid <uuid> --username <name> [--scope hotaru:ircserver]
 *
 * This is intentionally a seed helper, not a public API. The account has no
 * password; the UUID is linked directly by an operator for test fixtures.
 */
import { loadConfig } from '../src/config/env.js';
import { connectMongo, disconnectMongo } from '../src/infrastructure/mongo/connection.js';
import {
  MinecraftLinkModel,
  PermissionModel,
  UserModel,
} from '../src/infrastructure/mongo/models/index.js';

function usage(): never {
  console.error('Usage: seed-player --uuid <uuid> --username <name> [--scope <scope> ...]');
  process.exit(1);
}

function normalizedUuid(value: string): string {
  const hex = value.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error('invalid Minecraft UUID');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let uuid: string | null = null;
  let username: string | null = null;
  const scopes: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--uuid') uuid = args[++index] ?? null;
    else if (arg === '--username') username = args[++index] ?? null;
    else if (arg === '--scope') {
      const scope = args[++index];
      if (scope) scopes.push(scope);
    } else if (arg === '--help' || arg === '-h') {
      usage();
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!uuid || !username) usage();

  const config = loadConfig();
  await connectMongo(config);
  try {
    const minecraftUuid = normalizedUuid(uuid);
    const now = new Date();
    const user = await UserModel.findOneAndUpdate(
      { minecraftUuid },
      {
        $set: { username, status: 'active' },
        $setOnInsert: { loginName: null, passwordHash: null },
      },
      { upsert: true, new: true },
    );
    await MinecraftLinkModel.findOneAndUpdate(
      { minecraftUuid },
      {
        $set: {
          accountId: user._id,
          minecraftUsername: username,
          status: 'active',
        },
        $setOnInsert: { verifiedAt: now, linkedAt: now },
      },
      { upsert: true, new: true },
    );

    const grants = [...new Set([...config.defaultScopes, ...scopes])];
    for (const scope of grants) {
      await PermissionModel.updateOne(
        { userId: user._id, scope },
        {
          $setOnInsert: {
            userId: user._id,
            scope,
            expiresAt: null,
            grantedBy: 'system:seed-player',
          },
        },
        { upsert: true },
      );
    }

    console.log(`[seed-player] ${username} ${minecraftUuid} scopes=${grants.join(',')}`);
  } finally {
    await disconnectMongo();
  }
}

main().catch((error: unknown) => {
  console.error('[seed-player] failed:', error);
  process.exit(1);
});
