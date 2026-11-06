import type { Redis } from 'ioredis';
import type { AppConfig } from './config/env.js';
import type { ServiceKeys } from './infrastructure/crypto/keys.js';

/**
 * Everything a route module needs, created once at boot. Passed explicitly
 * instead of hidden behind decorators so modules stay unit-testable.
 */
export interface AppContext {
  config: AppConfig;
  keys: ServiceKeys;
  redis: Redis;
}
