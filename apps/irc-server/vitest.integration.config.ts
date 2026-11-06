import { defineConfig } from 'vitest/config';

/** Integration tests open real WebSocket connections to a server bound on a test port. */
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
