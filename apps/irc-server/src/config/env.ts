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
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  MONGODB_URI: z.string().min(1),
  MONGODB_DB: z.string().default('hotaru_irc'),
  /** Create declared indexes on boot (additive, never drops). Safe to leave on. */
  MONGODB_ENSURE_INDEXES: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  REDIS_URL: z.string().min(1),

  /** Auth server's public JWKS — the only trust anchor for access tokens. */
  AUTH_JWKS_URL: z.string().url().default('http://127.0.0.1:3000/api/v1/auth/jwks'),
  JWT_ISSUER: z.string().default('http://localhost:3000'),
  JWT_AUDIENCE: z.string().default('hotaru-api'),
  JWKS_CACHE_TTL_MS: z.coerce.number().int().positive().default(600_000),

  /** Identifies this node for presence routing and pub/sub channels. */
  INSTANCE_ID: z.string().default('irc-01'),

  /** Ping every heartbeatIntervalMs; terminate when a pong is missing after pongTimeoutMs. */
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).default(30_000),
  PONG_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(15_000),
  PRESENCE_TTL_MS: z.coerce.number().int().min(10_000).default(90_000),

  MAX_CONNECTIONS_PER_USER: z.coerce.number().int().min(1).default(3),
  MAX_CONNECTIONS_PER_IP: z.coerce.number().int().min(1).default(20),
  MAX_CONNECTIONS_TOTAL: z.coerce.number().int().min(1).default(10_000),

  MESSAGE_RATE_PER_SEC: z.coerce.number().int().min(1).default(20),
  MESSAGE_BURST: z.coerce.number().int().min(1).default(40),
  GROUP_MESSAGE_RATE_PER_SEC: z.coerce.number().int().min(1).default(10),
  CREATE_GROUP_PER_HOUR: z.coerce.number().int().min(1).default(5),

  MAX_PAYLOAD_BYTES: z.coerce.number().int().min(1024).default(64 * 1024),
  MAX_FRAME_BYTES: z.coerce.number().int().min(1024).default(128 * 1024),
  MAX_GROUP_MEMBERS: z.coerce.number().int().min(2).default(100),
  MAX_WS_BUFFERED_BYTES: z.coerce.number().int().min(1024).default(1024 * 1024),

  /** UUIDs allowed to edit global filter rules and to broadcast. */
  ADMIN_UUIDS: z.string().default(''),
  BROADCAST_ENABLED: z.enum(['true', 'false']).default('true'),
  DEDUPE_TTL_MS: z.coerce.number().int().min(1_000).default(120_000),
  CORS_ORIGINS: z.string().default(''),
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

  authJwksUrl: string;
  jwtIssuer: string;
  jwtAudience: string;
  jwksCacheTtlMs: number;

  instanceId: string;

  heartbeatIntervalMs: number;
  pongTimeoutMs: number;
  presenceTtlMs: number;

  maxConnectionsPerUser: number;
  maxConnectionsPerIp: number;
  maxConnectionsTotal: number;

  messageRatePerSec: number;
  messageBurst: number;
  groupMessageRatePerSec: number;
  createGroupPerHour: number;

  maxPayloadBytes: number;
  maxFrameBytes: number;
  maxGroupMembers: number;
  maxWsBufferedBytes: number;

  adminUuids: string[];
  broadcastEnabled: boolean;
  dedupeTtlMs: number;
  corsOrigins: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid IRC environment configuration:\n${issues}`);
  }
  const v = parsed.data;
  return {
    nodeEnv: v.NODE_ENV,
    host: v.HOST,
    port: v.PORT,
    logLevel: v.LOG_LEVEL,
    mongoUri: v.MONGODB_URI,
    mongoDb: v.MONGODB_DB,
    ensureIndexes: v.MONGODB_ENSURE_INDEXES,
    redisUrl: v.REDIS_URL,
    authJwksUrl: v.AUTH_JWKS_URL,
    jwtIssuer: v.JWT_ISSUER,
    jwtAudience: v.JWT_AUDIENCE,
    jwksCacheTtlMs: v.JWKS_CACHE_TTL_MS,
    instanceId: v.INSTANCE_ID,
    heartbeatIntervalMs: v.HEARTBEAT_INTERVAL_MS,
    pongTimeoutMs: v.PONG_TIMEOUT_MS,
    presenceTtlMs: v.PRESENCE_TTL_MS,
    maxConnectionsPerUser: v.MAX_CONNECTIONS_PER_USER,
    maxConnectionsPerIp: v.MAX_CONNECTIONS_PER_IP,
    maxConnectionsTotal: v.MAX_CONNECTIONS_TOTAL,
    messageRatePerSec: v.MESSAGE_RATE_PER_SEC,
    messageBurst: v.MESSAGE_BURST,
    groupMessageRatePerSec: v.GROUP_MESSAGE_RATE_PER_SEC,
    createGroupPerHour: v.CREATE_GROUP_PER_HOUR,
    maxPayloadBytes: v.MAX_PAYLOAD_BYTES,
    maxFrameBytes: v.MAX_FRAME_BYTES,
    maxGroupMembers: v.MAX_GROUP_MEMBERS,
    maxWsBufferedBytes: v.MAX_WS_BUFFERED_BYTES,
    adminUuids: csv(v.ADMIN_UUIDS).map((uuid) => uuid.toLowerCase()),
    broadcastEnabled: v.BROADCAST_ENABLED === 'true',
    dedupeTtlMs: v.DEDUPE_TTL_MS,
    corsOrigins: csv(v.CORS_ORIGINS),
  };
}
