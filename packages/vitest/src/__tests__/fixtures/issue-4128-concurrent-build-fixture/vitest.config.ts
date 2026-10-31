/**
 * Consumer-shaped fixture for issue #4128: `smrtVitestPlugin()` + setup +
 * `pool: 'forks'`, with a global setup that rewrites the production
 * `.smrt/manifest.json` after test generation, the way a concurrent build or
 * typecheck did. Imports the plugin/setup file from workspace source so the
 * fixture exercises the branch under test (as the #2750 fixture does).
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../../../index.ts';

export default defineConfig({
  plugins: [
    smrtVitestPlugin({
      setupFile: fileURLToPath(new URL('../../../setup.ts', import.meta.url)),
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    globalSetup: ['./concurrent-build.global-setup.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    fileParallelism: false,
  },
});
