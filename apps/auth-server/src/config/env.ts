import { z } from 'zod';
import 'dotenv/config';

const csv = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  MONGODB_URI: z.string().min(1),
  MONGODB_DB: z.string().default('hotaru_auth'),
  /** Create declared indexes on boot (additive, never drops). Safe to leave on. */
  MONGODB_ENSURE_INDEXES: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  REDIS_URL: z.string().min(1),

  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  JWT_ISSUER: z.string().url().optional(),
  JWT_AUDIENCE: z.string().default('hotaru-api'),
  PORTAL_JWT_AUDIENCE: z.string().default('hotaru-portal'),
  PORTAL_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  PORTAL_REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  PORTAL_BASE_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().url().default('http://localhost:3000'),
  ),
  IRC_HEALTH_URL: z.string().url().default('http://127.0.0.1:3001/health/ready'),
  TOTP_ISSUER: z.string().default('Hotaru'),

  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  CHALLENGE_TTL_SECONDS: z.coerce.number().int().min(10).max(300).default(60),
  BINDING_CODE_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),

  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_CHALLENGE_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_VERIFY_MAX: z.coerce.number().int().positive().default(10),

  MOJANG_SESSION_SERVER: z.string().url().default('https://sessionserver.mojang.com'),
  MOJANG_HAS_JOINED_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  MOJANG_HAS_JOINED_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),
  MOJANG_RETRY_DELAY_MS: z.coerce.number().int().nonnegative().default(500),

  DEFAULT_SCOPES: z.string().default('hotaru:profile'),
  CORS_ORIGINS: z.string().default(''),

  /** Ed25519 public key used to verify signed activation codes. */
  ACTIVATION_PUBLIC_KEY_PEM: z.string().optional(),
  ACTIVATION_PUBLIC_KEY_FILE: z.string().optional(),
  /** Ed25519 private key used by the admin API to issue signed activation codes. */
  ACTIVATION_PRIVATE_KEY_PEM: z.string().optional(),
  ACTIVATION_PRIVATE_KEY_FILE: z.string().optional(),
  /** Optional HTTP mail delivery endpoint; falls back to console output. */
  EMAIL_DELIVERY_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().url().optional(),
  ),
  EMAIL_FROM: z.string().default('no-reply@hotaru.local'),
  PASSWORD_RESET_TTL_SECONDS: z.coerce.number().int().min(300).max(86400).default(1800),

  JWT_PRIVATE_KEY_PEM: z.string().optional(),
  JWT_PUBLIC_KEY_PEM: z.string().optional(),
  MINECRAFT_RSA_PRIVATE_KEY_PEM: z.string().optional(),
  MINECRAFT_RSA_PUBLIC_KEY_PEM: z.string().optional(),
});

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];

  mongoUri: string;
  mongoDb: string;
  ensureIndexes: boolean;
  redisUrl: string;

  publicBaseUrl: string;
  jwtIssuer: string;
  jwtAudience: string;
  portalJwtAudience: string;
  portalTokenTtlSeconds: number;
  portalRefreshTokenTtlDays: number;
  portalBaseUrl: string;
  ircHealthUrl: string;
  totpIssuer: string;

  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  challengeTtlSeconds: number;
  bindingCodeTtlSeconds: number;

  rateLimitWindowSeconds: number;
  rateLimitChallengeMax: number;
  rateLimitVerifyMax: number;

  mojangSessionServer: string;
  mojangHasJoinedTimeoutMs: number;
  mojangHasJoinedAttempts: number;
  mojangRetryDelayMs: number;

  defaultScopes: string[];
  corsOrigins: string[];
  activationPublicKeyPem?: string;
  activationPublicKeyFile?: string;
  activationPrivateKeyPem?: string;
  activationPrivateKeyFile?: string;
  emailDeliveryUrl?: string;
  emailFrom: string;
  passwordResetTtlSeconds: number;

  jwtPrivateKeyPem?: string;
  jwtPublicKeyPem?: string;
  minecraftRsaPrivateKeyPem?: string;
  minecraftRsaPublicKeyPem?: string;
}

/**
 * Parses and validates process environment. Throws a readable aggregated error
 * instead of letting the process start half-configured.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const v = parsed.data;

  const config: AppConfig = {
    nodeEnv: v.NODE_ENV,
    host: v.HOST,
    port: v.PORT,
    logLevel: v.LOG_LEVEL,
    mongoUri: v.MONGODB_URI,
    mongoDb: v.MONGODB_DB,
    ensureIndexes: v.MONGODB_ENSURE_INDEXES,
    redisUrl: v.REDIS_URL,
    publicBaseUrl: v.PUBLIC_BASE_URL,
    jwtIssuer: v.JWT_ISSUER ?? v.PUBLIC_BASE_URL,
    jwtAudience: v.JWT_AUDIENCE,
    portalJwtAudience: v.PORTAL_JWT_AUDIENCE,
    portalTokenTtlSeconds: v.PORTAL_TOKEN_TTL_SECONDS,
    portalRefreshTokenTtlDays: v.PORTAL_REFRESH_TOKEN_TTL_DAYS,
    portalBaseUrl: v.PORTAL_BASE_URL,
    ircHealthUrl: v.IRC_HEALTH_URL,
    totpIssuer: v.TOTP_ISSUER,
    accessTokenTtlSeconds: v.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlDays: v.REFRESH_TOKEN_TTL_DAYS,
    challengeTtlSeconds: v.CHALLENGE_TTL_SECONDS,
    bindingCodeTtlSeconds: v.BINDING_CODE_TTL_SECONDS,
    rateLimitWindowSeconds: v.RATE_LIMIT_WINDOW_SECONDS,
    rateLimitChallengeMax: v.RATE_LIMIT_CHALLENGE_MAX,
    rateLimitVerifyMax: v.RATE_LIMIT_VERIFY_MAX,
    mojangSessionServer: v.MOJANG_SESSION_SERVER,
    mojangHasJoinedTimeoutMs: v.MOJANG_HAS_JOINED_TIMEOUT_MS,
    mojangHasJoinedAttempts: v.MOJANG_HAS_JOINED_ATTEMPTS,
    mojangRetryDelayMs: v.MOJANG_RETRY_DELAY_MS,
    defaultScopes: csv(v.DEFAULT_SCOPES),
    corsOrigins: csv(v.CORS_ORIGINS),
    emailFrom: v.EMAIL_FROM,
    passwordResetTtlSeconds: v.PASSWORD_RESET_TTL_SECONDS,
  };

  if (v.ACTIVATION_PUBLIC_KEY_PEM) {
    config.activationPublicKeyPem = v.ACTIVATION_PUBLIC_KEY_PEM.replace(/\\n/g, '\n');
  }
  if (v.ACTIVATION_PUBLIC_KEY_FILE) config.activationPublicKeyFile = v.ACTIVATION_PUBLIC_KEY_FILE;
  if (v.ACTIVATION_PRIVATE_KEY_PEM) {
    config.activationPrivateKeyPem = v.ACTIVATION_PRIVATE_KEY_PEM.replace(/\\n/g, '\n');
  }
  if (v.ACTIVATION_PRIVATE_KEY_FILE) config.activationPrivateKeyFile = v.ACTIVATION_PRIVATE_KEY_FILE;
  if (v.EMAIL_DELIVERY_URL) config.emailDeliveryUrl = v.EMAIL_DELIVERY_URL;
  config.emailFrom = v.EMAIL_FROM;
  config.passwordResetTtlSeconds = v.PASSWORD_RESET_TTL_SECONDS;

  if (v.JWT_PRIVATE_KEY_PEM) config.jwtPrivateKeyPem = v.JWT_PRIVATE_KEY_PEM;
  if (v.JWT_PUBLIC_KEY_PEM) config.jwtPublicKeyPem = v.JWT_PUBLIC_KEY_PEM;
  if (v.MINECRAFT_RSA_PRIVATE_KEY_PEM) config.minecraftRsaPrivateKeyPem = v.MINECRAFT_RSA_PRIVATE_KEY_PEM;
  if (v.MINECRAFT_RSA_PUBLIC_KEY_PEM) config.minecraftRsaPublicKeyPem = v.MINECRAFT_RSA_PUBLIC_KEY_PEM;

  return config;
}
