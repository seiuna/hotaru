/* global URL, process */

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import { argv as processArgv, stdin, stdout } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export class SetupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SetupError';
  }
}

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export const validators = {
  hostname(value) {
    if (value.length > 253) return '域名过长';
    const labels = value.split('.');
    if (labels.length < 2) return '域名至少需要两段';
    const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
    return labels.every((part) => label.test(part)) ? null : '域名格式不正确';
  },
  email(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? null : '邮箱格式不正确';
  },
  url(value) {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '只支持 http 或 https';
      if (parsed.username || parsed.password) return 'URL 不能包含用户名或密码';
      return null;
    } catch {
      return 'URL 格式不正确';
    }
  },
  publicBaseUrl(value) {
    const error = validators.url(value);
    if (error) return error;
    const parsed = new URL(value);
    if (parsed.pathname !== '/' && parsed.pathname !== '') return 'PUBLIC_BASE_URL 只能是源站，不能带路径';
    if (parsed.search || parsed.hash) return 'PUBLIC_BASE_URL 不能带查询串或 fragment';
    return null;
  },
  httpsUrl(value) {
    const error = validators.publicBaseUrl(value);
    if (error) return error;
    return new URL(value).protocol === 'https:' ? null : '生产环境必须使用 https://';
  },
  mongo(value) {
    return /^mongodb(\+srv)?:\/\/.+/.test(value) ? null : 'MongoDB 连接串必须以 mongodb:// 或 mongodb+srv:// 开头';
  },
  redis(value) {
    return /^rediss?:\/\/.+/.test(value) ? null : 'Redis 连接串必须以 redis:// 或 rediss:// 开头';
  },
  dbName(value) {
    if (!value) return '数据库名不能为空';
    if (/[\\."$*<>:|?\s]/.test(value)) return '数据库名包含非法字符';
    return value === '.' || value === '..' ? '数据库名不能是 . 或 ..' : null;
  },
  audience(value) {
    return /^[A-Za-z0-9._:-]+$/.test(value) ? null : 'audience 格式不正确';
  },
  instanceId(value) {
    return /^[a-z0-9][a-z0-9-]{0,62}$/.test(value) ? null : 'INSTANCE_ID 只允许小写字母、数字和连字符';
  },
  scopeList(value) {
    const scopes = value.split(',').map((scope) => scope.trim()).filter(Boolean);
    if (scopes.length === 0) return '至少需要一个 scope';
    if (new Set(scopes).size !== scopes.length) return 'scope 不能重复';
    return scopes.every((scope) => /^[a-z][a-z0-9:_-]*$/.test(scope)) ? null : 'scope 格式不正确';
  },
  identifier(value) {
    return /^[A-Za-z0-9._-]+$/.test(value) ? null : '只允许字母、数字、点、下划线和连字符';
  },
  secret(value) {
    return /^[A-Za-z0-9._~-]{16,}$/.test(value) ? null : '密码必须是至少 16 位 URL 安全字符';
  },
};

const localAuthFields = [
  {
    key: 'MONGODB_URI',
    label: 'MongoDB 连接串',
    section: '存储',
    defaultValue: 'mongodb://127.0.0.1:27017',
    required: true,
    validate: validators.mongo,
  },
  {
    key: 'MONGODB_DB',
    label: 'auth 数据库名',
    defaultValue: 'hotaru_auth',
    required: true,
    validate: validators.dbName,
  },
  {
    key: 'REDIS_URL',
    label: 'Redis 连接串',
    defaultValue: 'redis://127.0.0.1:16379',
    required: true,
    validate: validators.redis,
  },
  {
    key: 'PUBLIC_BASE_URL',
    label: 'auth 公开地址',
    section: '公开身份',
    defaultValue: 'http://localhost:3000',
    required: true,
    validate: validators.publicBaseUrl,
  },
  {
    key: 'JWT_AUDIENCE',
    label: 'JWT audience',
    defaultValue: 'hotaru-api',
    required: true,
    validate: validators.audience,
  },
  {
    key: 'DEFAULT_SCOPES',
    label: '默认 scopes',
    defaultValue: 'hotaru:profile',
    required: true,
    validate: validators.scopeList,
  },
];

const localIrcFields = [
  {
    key: 'MONGODB_URI',
    label: 'MongoDB 连接串',
    derive: (answers) => answers['apps/auth-server/.env'].MONGODB_URI,
    required: true,
    validate: validators.mongo,
  },
  {
    key: 'REDIS_URL',
    label: 'Redis 连接串',
    derive: (answers) => answers['apps/auth-server/.env'].REDIS_URL,
    required: true,
    validate: validators.redis,
  },
  {
    key: 'AUTH_JWKS_URL',
    label: 'auth JWKS 地址',
    derive: (answers) => `${answers['apps/auth-server/.env'].PUBLIC_BASE_URL}/api/v1/auth/jwks`,
    required: true,
    validate: validators.url,
  },
  {
    key: 'JWT_ISSUER',
    label: 'JWT issuer',
    derive: (answers) => answers['apps/auth-server/.env'].PUBLIC_BASE_URL,
    required: true,
    validate: validators.url,
  },
  {
    key: 'JWT_AUDIENCE',
    label: 'JWT audience',
    derive: (answers) => answers['apps/auth-server/.env'].JWT_AUDIENCE,
    required: true,
    validate: validators.audience,
  },
  {
    key: 'MONGODB_DB',
    label: 'IRC 数据库名',
    section: '存储',
    defaultValue: 'hotaru_irc',
    required: true,
    validate: validators.dbName,
  },
  {
    key: 'INSTANCE_ID',
    label: 'IRC 实例 ID',
    section: '运行时',
    defaultValue: 'irc-01',
    required: true,
    validate: validators.instanceId,
  },
];

const productionFields = [
  {
    key: 'AUTH_DOMAIN',
    label: 'auth 域名',
    section: '公开身份',
    required: true,
    validate: validators.hostname,
  },
  {
    key: 'ACME_EMAIL',
    label: 'Let\'s Encrypt 邮箱',
    required: true,
    validate: validators.email,
  },
  {
    key: 'PUBLIC_BASE_URL',
    label: 'auth 公开地址',
    defaultValue: (answers) => `https://${answers.AUTH_DOMAIN}`,
    required: true,
    validate: validators.httpsUrl,
  },
  {
    key: 'ADMIN_DOMAIN',
    label: 'admin 域名',
    defaultValue: (answers) => `admin.${answers.AUTH_DOMAIN}`,
    required: true,
    validate: validators.hostname,
  },
  {
    key: 'IRC_DOMAIN',
    label: 'IRC 域名',
    required: true,
    validate: validators.hostname,
  },
  {
    key: 'MONGO_INITDB_ROOT_USERNAME',
    label: 'MongoDB 用户名',
    section: '存储',
    defaultValue: 'hotaru',
    required: true,
    validate: validators.identifier,
  },
  {
    key: 'MONGODB_DB',
    label: 'auth 数据库名',
    defaultValue: 'hotaru_auth',
    required: true,
    validate: validators.dbName,
  },
  {
    key: 'MONGODB_IRC_DB',
    label: 'IRC 数据库名',
    defaultValue: 'hotaru_irc',
    required: true,
    validate: validators.dbName,
  },
  {
    key: 'MONGO_INITDB_ROOT_PASSWORD',
    label: 'MongoDB 密码',
    secret: true,
  },
  {
    key: 'REDIS_PASSWORD',
    label: 'Redis 密码',
    secret: true,
  },
  {
    key: 'JWT_AUDIENCE',
    label: 'JWT audience',
    section: '令牌',
    defaultValue: 'hotaru-api',
    required: true,
    validate: validators.audience,
  },
  {
    key: 'DEFAULT_SCOPES',
    label: '默认 scopes',
    defaultValue: 'hotaru:profile',
    required: true,
    validate: validators.scopeList,
  },
];

export const PROFILES = {
  local: {
    id: 'local',
    label: '本地开发',
    targets: [
      {
        path: 'apps/auth-server/.env',
        header:
          '# Generated by `pnpm run setup`. Git-ignored; never commit secrets.\n' +
          'NODE_ENV=development\nHOST=0.0.0.0\nPORT=3000\nLOG_LEVEL=info\n',
        fields: localAuthFields,
      },
      {
        path: 'apps/irc-server/.env',
        header:
          '# Generated by `pnpm run setup`. Git-ignored; never commit secrets.\n' +
          'NODE_ENV=development\nHOST=0.0.0.0\nPORT=3001\nLOG_LEVEL=info\nMONGODB_ENSURE_INDEXES=true\n',
        fields: localIrcFields,
      },
    ],
  },
  production: {
    id: 'production',
    label: '生产部署',
    targets: [
      {
        path: 'deploy/.env',
        seed: ['deploy/.env.example'],
        fields: productionFields,
      },
    ],
  },
};

function normalizeValue(field, raw) {
  let value = String(raw ?? '').trim();
  if (field.key.endsWith('_DOMAIN')) value = value.toLowerCase();
  if (field.key === 'PUBLIC_BASE_URL' || field.key.endsWith('_URL')) {
    value = value.replace(/\/+$/, '');
  }
  if (field.key === 'DEFAULT_SCOPES') {
    value = value.split(',').map((scope) => scope.trim()).filter(Boolean).join(',');
  }
  return value;
}

function resolveDefault(field, answers) {
  const value = typeof field.defaultValue === 'function' ? field.defaultValue(answers) : field.defaultValue;
  return value ?? '';
}

export function parseEnv(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const index = withoutExport.indexOf('=');
    if (index <= 0) continue;
    const key = withoutExport.slice(0, index).trim();
    let value = withoutExport.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function setEnvValue(text, key, value) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const normalized = text.replace(/\r\n/g, '\n');
  const trailing = normalized.endsWith('\n');
  let lines = normalized === '' ? [] : normalized.split('\n');
  if (trailing) lines.pop();

  let found = false;
  lines = lines.map((line) => {
    const match = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match || match[2] !== key) return line;
    found = true;
    return `${match[1]}${key}=${value}`;
  });

  if (!found) lines.push(`${key}=${value}`);
  return lines.join(eol) + eol;
}

export function renderTarget({ target, answers, existingText }) {
  let content = existingText && existingText.trim().length > 0 ? existingText : target.header ?? '';
  for (const field of target.fields) {
    const value = answers[field.key];
    if (value === undefined) continue;
    content = setEnvValue(content, field.key, value);
  }
  return content;
}

export function generateSecret() {
  return randomBytes(24).toString('base64url');
}

function assertValid(field, value) {
  if (field.required && !value) throw new SetupError(`${field.key} 不能为空`);
  const error = field.validate ? field.validate(value) : null;
  if (error) throw new SetupError(`${field.key}: ${error}`);
}

async function askValidated(io, field, initialValue) {
  let current = initialValue;
  for (;;) {
    const raw = await io.ask({ ...field, defaultValue: current });
    const value = normalizeValue(field, raw);
    if (field.required && !value) {
      io.log(`  ${field.key} 不能为空`);
      continue;
    }
    const error = field.validate ? field.validate(value) : null;
    if (!error) return value;
    io.log(`  ${field.key}: ${error}`);
  }
}

async function readIfExists(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function loadTarget(root, target) {
  const absolutePath = join(root, target.path);
  const existingText = await readIfExists(absolutePath);
  if (existingText !== null) {
    return { absolutePath, text: existingText, existing: true, source: null };
  }
  for (const seedPath of target.seed ?? []) {
    const absoluteSeed = join(root, seedPath);
    const seedText = await readIfExists(absoluteSeed);
    if (seedText !== null) {
      return { absolutePath, text: seedText, existing: false, source: absoluteSeed };
    }
  }
  return { absolutePath, text: target.header ?? '', existing: false, source: null };
}

function validateAnswers(profileId, answers) {
  if (profileId === 'production') {
    const env = answers['deploy/.env'];
    if (!env) return;
    const domains = [env.AUTH_DOMAIN, env.ADMIN_DOMAIN, env.IRC_DOMAIN].map((domain) => domain.toLowerCase());
    if (new Set(domains).size !== 3) {
      throw new SetupError('AUTH_DOMAIN、ADMIN_DOMAIN、IRC_DOMAIN 必须是三个不同的域名');
    }
    if (new URL(env.PUBLIC_BASE_URL).hostname.toLowerCase() !== env.AUTH_DOMAIN.toLowerCase()) {
      throw new SetupError('PUBLIC_BASE_URL 的域名必须等于 AUTH_DOMAIN');
    }
  }

  if (profileId === 'local') {
    const auth = answers['apps/auth-server/.env'];
    const irc = answers['apps/irc-server/.env'];
    if (!auth || !irc) return;
    if (irc.JWT_ISSUER !== auth.PUBLIC_BASE_URL) {
      throw new SetupError('IRC JWT_ISSUER 必须等于 auth PUBLIC_BASE_URL');
    }
    if (irc.AUTH_JWKS_URL !== `${auth.PUBLIC_BASE_URL}/api/v1/auth/jwks`) {
      throw new SetupError('IRC AUTH_JWKS_URL 必须指向 auth 的 JWKS 地址');
    }
    if (irc.JWT_AUDIENCE !== auth.JWT_AUDIENCE) {
      throw new SetupError('auth 和 IRC 的 JWT_AUDIENCE 必须一致');
    }
  }
}

export async function runSetup({
  root = '.',
  profileId,
  profile,
  io,
  yes = false,
  rotateSecrets = false,
}) {
  const selectedProfile = profile ?? PROFILES[profileId];
  if (!selectedProfile) throw new SetupError(`未知配置目标: ${profileId}`);
  const absoluteRoot = resolve(root);
  const answers = {};
  const files = [];

  for (const target of selectedProfile.targets) {
    const loaded = await loadTarget(absoluteRoot, target);
    const existingEnv = parseEnv(loaded.text);
    const targetAnswers = {};
    let currentSection = null;

    for (const field of target.fields) {
      if (field.section && field.section !== currentSection) {
        currentSection = field.section;
        if (!yes) io.log(`\n[${field.section}]`);
      }

      if (field.derive) {
        const value = normalizeValue(field, field.derive(answers));
        assertValid(field, value);
        targetAnswers[field.key] = value;
        continue;
      }

      if (field.secret) {
        const existingValue = existingEnv[field.key];
        const placeholder = !existingValue || existingValue.startsWith('CHANGE_ME');
        if (!rotateSecrets && !placeholder) {
          const error = validators.secret(existingValue);
          if (error) {
            throw new SetupError(`${field.key} 的现有值不是 URL 安全密码: ${error}；请同步修改 MongoDB/Redis 密码，或使用 --rotate-secrets 生成新值`);
          }
          targetAnswers[field.key] = existingValue;
        } else {
          targetAnswers[field.key] = generateSecret();
        }
        continue;
      }

      const defaultValue = resolveDefault(field, targetAnswers);
      const current = loaded.existing && existingEnv[field.key] ? existingEnv[field.key] : defaultValue;

      if (yes) {
        const value = normalizeValue(field, current);
        assertValid(field, value);
        targetAnswers[field.key] = value;
      } else {
        targetAnswers[field.key] = await askValidated(io, field, current);
      }
    }

    const content = renderTarget({ target, answers: targetAnswers, existingText: loaded.text });
    files.push({
      path: target.path,
      absolutePath: loaded.absolutePath,
      content,
      changed: content !== loaded.text,
      existing: loaded.existing,
      sourceText: loaded.text,
      secretKeys: target.fields.filter((field) => field.secret).map((field) => field.key),
    });
    answers[target.path] = targetAnswers;
  }

  validateAnswers(selectedProfile.id, answers);
  return { files, answers };
}

function listChanges(beforeText, afterText, secretKeys) {
  const before = parseEnv(beforeText);
  const after = parseEnv(afterText);
  const secrets = new Set(secretKeys);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter((key) => before[key] !== after[key])
    .map((key) => (secrets.has(key) ? `${key}=********` : `${key}=${after[key]}`));
}

function printPlan(files, output, dryRun) {
  output.write(dryRun ? '\n预览，不会写入:\n' : '\n将要更新:\n');
  for (const file of files) {
    if (!file.changed) {
      output.write(`  未变化 ${file.path}\n`);
      continue;
    }
    output.write(`  ${file.existing ? '更新' : '创建'} ${file.path}\n`);
    for (const change of listChanges(file.sourceText, file.content, file.secretKeys)) {
      output.write(`    ${change}\n`);
    }
  }
}

export async function writeFiles(files) {
  const written = [];
  for (const file of files) {
    if (!file.changed) continue;
    await mkdir(dirname(file.absolutePath), { recursive: true });
    const tempPath = `${file.absolutePath}.tmp-${process.pid}`;
    await writeFile(tempPath, file.content, { mode: 0o600 });
    try {
      await rename(tempPath, file.absolutePath);
    } catch {
      await writeFile(file.absolutePath, file.content, { mode: 0o600 });
      await rm(tempPath, { force: true });
    }
    await chmod(file.absolutePath, 0o600).catch(() => {});
    written.push(file.path);
  }
  return written;
}

export function createReadlineIO({ input = stdin, output = stdout } = {}) {
  const rl = createInterface({ input, output, terminal: Boolean(input.isTTY) });
  const lines = rl[Symbol.asyncIterator]();
  rl.on('SIGINT', () => {
    output.write('\n已取消。\n');
    process.exit(130);
  });

  async function nextLine(prompt) {
    output.write(prompt);
    const { value, done } = await lines.next();
    if (done) throw new SetupError('输入已结束');
    return String(value ?? '').trim();
  }

  return {
    interactive: Boolean(input.isTTY),
    async ask({ label, defaultValue }) {
      const hint = defaultValue ? ` [${defaultValue}]` : '';
      const answer = await nextLine(`${label}${hint}: `);
      return answer || defaultValue || '';
    },
    async confirm(message, defaultYes = true) {
      const answer = (await nextLine(`${message} ${defaultYes ? '[Y/n]' : '[y/N]'}: `)).toLowerCase();
      if (!answer) return defaultYes;
      return answer === 'y' || answer === 'yes' || answer === '是';
    },
    log(message) {
      output.write(`${message}\n`);
    },
    close() {
      rl.close();
    },
  };
}

async function askProfile(io) {
  io.log('选择配置目标:');
  io.log('  1) 本地开发 (local)');
  io.log('  2) 生产部署 (production)');
  for (;;) {
    const answer = (await io.ask({ label: '配置目标', defaultValue: '1' })).toLowerCase();
    if (answer === '1' || answer === 'local') return 'local';
    if (answer === '2' || answer === 'production') return 'production';
    io.log('请输入 1 或 2。');
  }
}

function parseArgs(args) {
  const options = {
    profile: undefined,
    root: REPO_ROOT,
    yes: false,
    dryRun: false,
    rotateSecrets: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--yes' || arg === '-y') {
      options.yes = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--rotate-secrets') {
      options.rotateSecrets = true;
    } else if (arg === '--profile') {
      options.profile = args[index + 1];
      index += 1;
      if (!options.profile) throw new SetupError('--profile 需要一个值');
    } else if (arg === '--root') {
      options.root = args[index + 1];
      index += 1;
      if (!options.root) throw new SetupError('--root 需要一个值');
    } else {
      throw new SetupError(`未知参数: ${arg}`);
    }
  }

  return options;
}

const HELP = `用法:
  pnpm run setup [选项]

选项:
  --profile local|production  跳过目标选择
  --yes                       使用默认值，不进入交互
  --dry-run                   只显示将要写入的内容
  --rotate-secrets            重新生成 production 密码；只改 deploy/.env，不同步 MongoDB/Redis
  --root <path>               在指定目录下读写配置，默认仓库根目录
  --help                      显示帮助

注意:
  pnpm setup 是 pnpm 的内置命令。必须用 pnpm run setup 来运行本工具。

配置目标:
  local        写入 apps/auth-server/.env 和 apps/irc-server/.env
  production   以 deploy/.env.example 为模板写入 deploy/.env
`;

const NEXT_STEPS = {
  local: `\n下一步:
  docker start hotaru-mongo hotaru-redis
  pnpm --filter @hotaru/auth-server dev
  pnpm --filter @hotaru/irc-server dev
  pnpm --filter @hotaru/admin-web dev
`,
  production: `\n下一步:
  docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --build
  pnpm --filter @hotaru/auth-server admin:seed -- --uuid <uuid> --username <name>
`,
};

export async function main(argv = processArgv, { input = stdin, output = stdout, io } = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv.slice(2));
  } catch (error) {
    output.write(`错误: ${error.message}\n`);
    return 1;
  }

  if (parsed.help) {
    output.write(HELP);
    return 0;
  }

  const adapter = io ?? createReadlineIO({ input, output });
  try {
    let profileId = parsed.profile;
    if (!profileId) {
      if (!adapter.interactive) {
        throw new SetupError('缺少 --profile。非交互运行请传 --profile local 或 --profile production');
      }
      profileId = await askProfile(adapter);
    }
    if (!PROFILES[profileId]) throw new SetupError(`未知配置目标: ${profileId}`);

    const result = await runSetup({
      root: parsed.root,
      profileId,
      io: adapter,
      yes: parsed.yes,
      dryRun: parsed.dryRun,
      rotateSecrets: parsed.rotateSecrets,
    });

    printPlan(result.files, output, parsed.dryRun);
    if (parsed.dryRun) return 0;

    if (!parsed.yes) {
      const confirmed = await adapter.confirm('写入这些文件?', true);
      if (!confirmed) {
        output.write('已取消，未写入任何文件。\n');
        return 0;
      }
    }

    const written = await writeFiles(result.files);
    output.write(`\n已写入 ${written.length} 个文件。\n`);
    output.write(NEXT_STEPS[profileId]);
    return 0;
  } catch (error) {
    output.write(`\n错误: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    if (!io && adapter.close) adapter.close();
  }
}

if (processArgv[1] && pathToFileURL(processArgv[1]).href === import.meta.url) {
  main().then((code) => {
    process.exitCode = code;
  });
}
