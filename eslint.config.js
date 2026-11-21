import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist', 'dist-firefox', 'node_modules', 'coverage', 'public'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    // Deliberate: the filename sanitiser strips control chars and the HLS parser strips a BOM.
    files: ['src/core/filename.ts', 'src/core/media/hls.ts'],
    rules: { 'no-control-regex': 'off', 'no-irregular-whitespace': 'off' },
  },
);
