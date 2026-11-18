import { defineConfig } from 'vitest/config';
import { crx, defineManifest } from '@crxjs/vite-plugin';
import { buildManifest } from './src/manifest';

export default defineConfig(({ mode }) => {
  const youtube = mode === 'personal';
  return {
    // other worktrees live under .claude/; their tests must not run here
    test: { exclude: ['**/node_modules/**', '.claude/**', 'dist*/**', 'release/**'] },
    define: { __YOUTUBE__: JSON.stringify(youtube) },
    plugins: [crx({ manifest: defineManifest(buildManifest({ youtube })) })],
    build: {
      target: 'es2022',
      rollupOptions: {
        input: { offscreen: 'src/offscreen/index.html' },
      },
    },
  };
});
