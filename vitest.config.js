import { defineConfig } from 'vitest/config';

// Tests for the simulation core only (pure JS, runs in Node). The browser pages are checked by `npm run build`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
