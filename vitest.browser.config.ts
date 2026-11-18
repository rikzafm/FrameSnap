import { defineConfig } from 'vitest/config';

/** Real-browser tests (OPFS). Uses the installed Chrome, so no browser download is needed. */
export default defineConfig({
  test: {
    include: ['tests/browser/**/*.test.ts'],
    browser: {
      enabled: true,
      headless: true,
      provider: 'playwright',
      instances: [{ browser: 'chromium', launch: { channel: 'chrome' } }],
    },
  },
});
