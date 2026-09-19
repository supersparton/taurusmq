import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/vitest/**/*.test.js'],
    testTimeout: 60000,
    hookTimeout: 180000,
    teardownTimeout: 30000,
    pool: 'forks',
  },
});
