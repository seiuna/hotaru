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
  MONGODB_DB: z.string().default('skymatrix_auth'),
  /** Create declared indexes on boot (additive, never drops). Safe to leave on. */
  MONGODB_ENSURE_INDEXES: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  REDIS_URL: z.string().min(1),

  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  JWT_ISSUER: z.string().url().optional(),
  JWT_AUDIENCE: z.string().default('skymatrix-api'),

  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  CHALLENGE_TTL_SECONDS: z.coerce.number().int().min(10).max(300).default(60),

  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_CHALLENGE_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_VERIFY_MAX: z.coerce.number().int().positive().default(10),

  MOJANG_SESSION_SERVER: z.string().url().default('https://sessionserver.mojang.com'),
  MOJANG_HAS_JOINED_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  MOJANG_HAS_JOINED_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),
  MOJANG_RETRY_DELAY_MS: z.coerce.number().int().nonnegative().default(500),

  DEFAULT_SCOPES: z.string().default('skymatrix:profile'),
  CORS_ORIGINS: z.string().default(''),

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

  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  challengeTtlSeconds: number;

  rateLimitWindowSeconds: number;
  rateLimitChallengeMax: number;
  rateLimitVerifyMax: number;

  mojangSessionServer: string;
  mojangHasJoinedTimeoutMs: number;
  mojangHasJoinedAttempts: number;
  mojangRetryDelayMs: number;

  defaultScopes: string[];
  corsOrigins: string[];

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
    accessTokenTtlSeconds: v.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlDays: v.REFRESH_TOKEN_TTL_DAYS,
    challengeTtlSeconds: v.CHALLENGE_TTL_SECONDS,
    rateLimitWindowSeconds: v.RATE_LIMIT_WINDOW_SECONDS,
    rateLimitChallengeMax: v.RATE_LIMIT_CHALLENGE_MAX,
    rateLimitVerifyMax: v.RATE_LIMIT_VERIFY_MAX,
    mojangSessionServer: v.MOJANG_SESSION_SERVER,
    mojangHasJoinedTimeoutMs: v.MOJANG_HAS_JOINED_TIMEOUT_MS,
    mojangHasJoinedAttempts: v.MOJANG_HAS_JOINED_ATTEMPTS,
    mojangRetryDelayMs: v.MOJANG_RETRY_DELAY_MS,
    defaultScopes: csv(v.DEFAULT_SCOPES),
    corsOrigins: csv(v.CORS_ORIGINS),
  };

  if (v.JWT_PRIVATE_KEY_PEM) config.jwtPrivateKeyPem = v.JWT_PRIVATE_KEY_PEM;
  if (v.JWT_PUBLIC_KEY_PEM) config.jwtPublicKeyPem = v.JWT_PUBLIC_KEY_PEM;
  if (v.MINECRAFT_RSA_PRIVATE_KEY_PEM) config.minecraftRsaPrivateKeyPem = v.MINECRAFT_RSA_PRIVATE_KEY_PEM;
  if (v.MINECRAFT_RSA_PUBLIC_KEY_PEM) config.minecraftRsaPublicKeyPem = v.MINECRAFT_RSA_PUBLIC_KEY_PEM;

  return config;
}
