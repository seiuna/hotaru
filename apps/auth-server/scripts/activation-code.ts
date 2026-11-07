/**
 * Generate Ed25519 activation keys or sign an activation code.
 *
 *   pnpm --filter @hotaru/auth-server activation:code -- --keygen
 *   pnpm --filter @hotaru/auth-server activation:code -- --type account --expires-in 7d
 *   pnpm --filter @hotaru/auth-server activation:code -- --type bind --uuid <uuid> --username <name> --expires-in 1h
 *
 * The private key stays on the issuing machine. The auth server only needs the
 * public key, via ACTIVATION_PUBLIC_KEY_PEM or ACTIVATION_PUBLIC_KEY_FILE.
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { signActivationCode, type ActivationType } from '../src/infrastructure/activation/code.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function fromRepoRoot(value: string): string {
  return isAbsolute(value) ? value : resolve(repoRoot, value);
}

interface Args {
  keygen: boolean;
  type: ActivationType;
  expiresIn: string;
  uuid?: string;
  username?: string;
  key?: string;
  outDir: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    keygen: false,
    type: 'account',
    expiresIn: '7d',
    outDir: fromRepoRoot('deploy'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--keygen') args.keygen = true;
    else if (arg === '--type') args.type = argv[++index] as ActivationType;
    else if (arg === '--expires-in') args.expiresIn = argv[++index] ?? '7d';
    else if (arg === '--uuid') args.uuid = argv[++index];
    else if (arg === '--username') args.username = argv[++index];
    else if (arg === '--key') args.key = fromRepoRoot(argv[++index] ?? '');
    else if (arg === '--out-dir') args.outDir = fromRepoRoot(argv[++index] ?? 'deploy');
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: activation-code --keygen [--out-dir deploy]');
      console.log('       activation-code --type account|bind|claim --expires-in 7d [--uuid UUID] [--username NAME] [--key private.pem]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function parseDuration(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (!match) throw new Error('--expires-in must look like 30m, 12h or 7d');
  const amount = Number(match[1]);
  const unit = match[2];
  const seconds = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400;
  return amount * seconds;
}

async function keygen(outDir: string): Promise<void> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  await mkdir(outDir, { recursive: true });
  const privatePath = join(outDir, 'activation-private.pem');
  const publicPath = join(outDir, 'activation-public.pem');
  await writeFile(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  await writeFile(publicPath, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 });
  console.log(`private key: ${privatePath}`);
  console.log(`public key:  ${publicPath}`);
  console.log('Set ACTIVATION_PUBLIC_KEY_FILE to the public key path on the auth server.');
}

async function privateKeyFrom(args: Args): Promise<string> {
  if (args.key) return readFile(args.key, 'utf8');
  if (process.env.ACTIVATION_PRIVATE_KEY_PEM) return process.env.ACTIVATION_PRIVATE_KEY_PEM.replace(/\\n/g, '\n');
  if (process.env.ACTIVATION_PRIVATE_KEY_FILE) return readFile(process.env.ACTIVATION_PRIVATE_KEY_FILE, 'utf8');
  throw new Error('private key missing: pass --key <file> or set ACTIVATION_PRIVATE_KEY_PEM / ACTIVATION_PRIVATE_KEY_FILE');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.keygen) {
    await keygen(args.outDir);
    return;
  }
  if (args.type !== 'account' && !args.uuid) {
    throw new Error('--type bind and --type claim require --uuid');
  }
  if (args.type === 'bind' && !args.username) {
    throw new Error('--type bind requires --username');
  }
  if (args.type !== 'account' && args.type !== 'bind' && args.type !== 'claim') {
    throw new Error('--type must be account, bind or claim');
  }

  const exp = Math.floor(Date.now() / 1000) + parseDuration(args.expiresIn);
  const payload = {
    v: 1 as const,
    type: args.type,
    jti: randomUUID(),
    exp,
    ...(args.type !== 'account' ? { uuid: args.uuid } : {}),
    ...(args.type === 'bind' ? { username: args.username } : {}),
  };
  const code = signActivationCode(payload, await privateKeyFrom(args));
  console.log(code);
}

main().catch((error: unknown) => {
  console.error(`[activation-code] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
