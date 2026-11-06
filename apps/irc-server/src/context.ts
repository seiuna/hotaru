import type { Redis } from 'ioredis';
import type { AppConfig } from './config/env.js';

/** Everything a module needs, created once at boot and passed explicitly. */
export interface AppContext {
  config: AppConfig;
  redis: Redis;
  instanceId: string;
  /** Wall clock, injectable so tests can control TTL/expiry decisions. */
  now: () => number;
}
