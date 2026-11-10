/**
 * Consumer-shaped fixture for #2954: `smrtVitestPlugin()` + `pool: 'forks'`.
 * The spec proves sibling specifiers resolve to source and that one which can
 * only resolve to a sibling's built dist fails. Imports the plugin from
 * workspace source.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../../../index.ts';

export default defineConfig({
  plugins: [
    smrtVitestPlugin({
      generateManifest: false,
      setupFile: fileURLToPath(new URL('../../../setup.ts', import.meta.url)),
    }),
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    testTimeout: 30000,
    pool: 'forks',
  },
});
