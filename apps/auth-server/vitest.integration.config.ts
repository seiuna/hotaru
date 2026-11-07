import { defineConfig } from 'vitest/config';

/**
 * Integration-test configuration. These tests talk to the real MongoDB and
 * Redis containers, so they run serially (one file at a time) to avoid racing on
 * shared collections, and they get a longer hook budget for container latency.
 *
 * Required environment:
 *   MONGODB_URI=mongodb://127.0.0.1:27017
 *   MONGODB_DB=hotaru_auth_test
 *   REDIS_URL=redis://127.0.0.1:16379   (6379 cannot be bound on this host)
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    reporters: ['default'],
  },
});
