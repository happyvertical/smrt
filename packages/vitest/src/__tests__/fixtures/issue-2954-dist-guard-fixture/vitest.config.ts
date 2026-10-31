/**
 * Consumer-shaped fixture for #2954: `smrtVitestPlugin()` + `pool: 'forks'`.
 * The spec loads a workspace sibling's built dist directly and expects the
 * plugin's guard to refuse it. Imports the plugin from workspace source.
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
