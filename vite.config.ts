import { defineConfig } from 'vitest/config';
import { crx, defineManifest } from '@crxjs/vite-plugin';
import { buildManifest } from './src/manifest';

export default defineConfig(({ mode }) => {
  const browser = mode === 'firefox' ? 'firefox' : 'chrome';
  return {
    // other worktrees live under .claude/; their tests must not run here
    test: { exclude: ['**/node_modules/**', '.claude/**', 'dist/**', 'dist-firefox/**', 'release/**'] },
    plugins: [
      crx({
        manifest: defineManifest(buildManifest(browser)),
        browser,
        contentScripts: {
          standaloneFiles: [
            'src/main-world/net-tap-main.ts',
            'src/main-world/youtube-main.ts',
            'src/main-world/mse-main.ts',
          ],
        },
      }),
    ],
    build: {
      target: 'es2022',
      outDir: browser === 'firefox' ? 'dist-firefox' : 'dist',
      ...(browser === 'chrome'
        ? {
            rollupOptions: {
              input: { offscreen: 'src/offscreen/index.html' },
            },
          }
        : {}),
    },
  };
});
