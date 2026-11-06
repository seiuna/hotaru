/**
 * Grants the `admin:users` scope to a Minecraft account.
 *
 * Usage (from the repo root):
 *   pnpm --filter @skymatrix/auth-server admin:seed -- --uuid <minecraft-uuid> [--username Name]
 *
 * Idempotent: running it twice leaves the database in the same state. The
 * account is created (status active) when it does not exist yet; an existing
 * account is reactivated and renamed to `--username` when that flag is given.
 *
 * Exit codes: 0 success, 1 bad arguments or database failure.
 */
import { loadConfig } from '../src/config/env.js';
import { connectMongo, disconnectMongo } from '../src/infrastructure/mongo/connection.js';
import {
  AdminModel,
  PermissionModel,
  UserModel,
} from '../src/infrastructure/mongo/models/index.js';
import { minecraftUuidSchema, usernameSchema } from '@skymatrix/api-contract';

const SEED_ACTOR = 'system:seed-admin';
const ADMIN_SCOPE = 'admin:users';

const USAGE = [
  'Usage: pnpm --filter @skymatrix/auth-server admin:seed -- --uuid <minecraft-uuid> [--username Name]',
  '',
  '  --uuid       Mojang UUID, dashed or undashed (required)',
  '  --username   Minecraft username; required when the account is not known yet',
].join('\n');

class UsageError extends Error {}

interface SeedArgs {
  uuid: string;
  username: string | null;
}

/** `--uuid x`, `--uuid=x`, `--username Name`; anything else is a usage error. */
function parseArgs(argv: string[]): SeedArgs {
  let uuid: string | null = null;
  let username: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index] ?? '';
    const [flag, inlineValue] = raw.includes('=') ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)] : [raw, undefined];
    const nextValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError(`Missing value for ${flag}`);
      index += 1;
      return value;
    };

    switch (flag) {
      case '--uuid':
        uuid = nextValue();
        break;
      case '--username':
        username = nextValue();
        break;
      case '-h':
      case '--help':
        throw new UsageError('help requested');
      default:
        throw new UsageError(`Unknown argument: ${raw}`);
    }
  }

  if (!uuid) throw new UsageError('--uuid is required');

  // Mojang UUIDs are canonical dashed lowercase; accept the undashed paste form
  // and normalise it instead of rejecting an operator's copy/paste.
  const undashed = uuid.trim().toLowerCase().replace(/-/g, '');
  const dashed =
    undashed.length === 32
      ? `${undashed.slice(0, 8)}-${undashed.slice(8, 12)}-${undashed.slice(12, 16)}-${undashed.slice(16, 20)}-${undashed.slice(20)}`
      : uuid.trim().toLowerCase();

  const parsedUuid = minecraftUuidSchema.safeParse(dashed);
  if (!parsedUuid.success) throw new UsageError(`--uuid is not a valid Minecraft UUID: ${uuid}`);

  let parsedUsername: string | null = null;
  if (username !== null) {
    const result = usernameSchema.safeParse(username);
    if (!result.success) throw new UsageError(`--username is not a valid Minecraft username: ${username}`);
    parsedUsername = result.data;
  }

  return { uuid: parsedUuid.data, username: parsedUsername };
}

type UpsertOutcome = 'created' | 'updated' | 'unchanged';

async function seed(args: SeedArgs): Promise<void> {
  const config = loadConfig();
  await connectMongo(config);
  try {
    const existing = await UserModel.findOne({ minecraftUuid: args.uuid }).lean();
    if (!existing && args.username === null) {
      throw new UsageError('--username is required when the account does not exist yet');
    }

    let userId: string;
    let userOutcome: UpsertOutcome;
    let userLabel: string;

    if (existing) {
      const needsStatusFix =
        existing.status !== 'active' || existing.bannedAt != null || existing.banReason != null;
      const needsRename = args.username !== null && args.username !== existing.username;
      userId = String(existing._id);
      userLabel = args.username ?? existing.username;
      if (!needsStatusFix && !needsRename) {
        userOutcome = 'unchanged';
      } else {
        const patch: Record<string, unknown> = { status: 'active', banReason: null, bannedAt: null };
        if (args.username !== null) patch.username = args.username;
        await UserModel.updateOne({ _id: existing._id }, { $set: patch });
        userOutcome = 'updated';
        if (existing.status === 'banned') console.log(`[seed-admin] user was banned; reactivating ${userId}`);
      }
    } else {
      const created = await UserModel.create({
        minecraftUuid: args.uuid,
        username: args.username,
        status: 'active',
      });
      userId = String(created._id);
      userOutcome = 'created';
      userLabel = args.username ?? '(unknown)';
    }

    const existingPermission = await PermissionModel.findOne({ userId, scope: ADMIN_SCOPE }).lean();
    let permissionOutcome: UpsertOutcome;
    if (!existingPermission) {
      await PermissionModel.create({
        userId,
        scope: ADMIN_SCOPE,
        expiresAt: null,
        grantedBy: SEED_ACTOR,
      });
      permissionOutcome = 'created';
    } else if (existingPermission.expiresAt == null && existingPermission.grantedBy === SEED_ACTOR) {
      permissionOutcome = 'unchanged';
    } else {
      await PermissionModel.updateOne(
        { _id: existingPermission._id },
        { $set: { expiresAt: null, grantedBy: SEED_ACTOR } },
      );
      permissionOutcome = 'updated';
    }

    const existingAdmin = await AdminModel.findOne({ identity: args.uuid }).lean();
    let adminOutcome: UpsertOutcome;
    if (!existingAdmin) {
      await AdminModel.create({ identity: args.uuid, role: 'owner', createdBy: SEED_ACTOR });
      adminOutcome = 'created';
    } else if (existingAdmin.role === 'owner') {
      adminOutcome = 'unchanged';
    } else {
      await AdminModel.updateOne({ _id: existingAdmin._id }, { $set: { role: 'owner' } });
      adminOutcome = 'updated';
    }

    console.log(`[seed-admin] user        ${userOutcome.padEnd(9)} id=${userId} uuid=${args.uuid} username=${userLabel}`);
    console.log(`[seed-admin] permission  ${permissionOutcome.padEnd(9)} scope=${ADMIN_SCOPE} expiresAt=never`);
    console.log(`[seed-admin] admin       ${adminOutcome.padEnd(9)} role=owner identity=${args.uuid}`);
    console.log('[seed-admin] done');
  } finally {
    await disconnectMongo();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await seed(args);
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    console.error(`[seed-admin] ${error.message === 'help requested' ? '' : `error: ${error.message}`}`);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  console.error('[seed-admin] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
