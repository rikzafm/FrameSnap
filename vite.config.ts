import { defineConfig } from 'vite';
import { crx, defineManifest } from '@crxjs/vite-plugin';
import { buildManifest } from './src/manifest';

export default defineConfig(({ mode }) => {
  const youtube = mode === 'personal';
  return {
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
