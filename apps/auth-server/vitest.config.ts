import { defineConfig } from 'vitest/config';

/**
 * Unit-test configuration.
 *
 * Integration tests are deliberately excluded here and live in
 * vitest.integration.config.ts. The split lives in config files rather than
 * CLI globs because on Windows a quoted --exclude glob reaches vitest with the
 * quotes still attached and silently matches nothing.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ['default'],
  },
});
