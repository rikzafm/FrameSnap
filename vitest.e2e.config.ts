import { defineConfig } from 'vitest/config';

/** Real-Chrome e2e: loads the built extension. Run `npm run build` first. */
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    exclude: ['**/node_modules/**', '.claude/**'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
