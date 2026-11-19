import { defineConfig } from 'vitest/config';
import { crx, defineManifest } from '@crxjs/vite-plugin';
import { buildManifest } from './src/manifest';

export default defineConfig({
  // other worktrees live under .claude/; their tests must not run here
  test: { exclude: ['**/node_modules/**', '.claude/**', 'dist/**', 'release/**'] },
  plugins: [crx({ manifest: defineManifest(buildManifest()) })],
  build: {
    target: 'es2022',
    rollupOptions: {
      input: { offscreen: 'src/offscreen/index.html' },
    },
  },
});
