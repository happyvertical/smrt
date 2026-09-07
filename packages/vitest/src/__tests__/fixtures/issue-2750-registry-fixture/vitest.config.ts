/**
 * Consumer-shaped fixture for issue #2750.
 *
 * Mirrors the exact config from the issue's reproducer: `smrtVitestPlugin()`
 * + `setupFiles: ['@happyvertical/smrt-vitest/setup']`, `pool: 'forks'`,
 * `singleFork: true`. Vitest 4 replaced the old `poolOptions.forks.singleFork`
 * (removed entirely, not just relocated — it no longer exists anywhere in the
 * package's types) with the unified `fileParallelism: false`, which is what
 * actually forces every test file to share the single forked worker process
 * this regression depends on. Imports the plugin/setup file from workspace
 * *source* (not `dist/`) so this fixture exercises whatever fix is currently
 * on the branch, the same way other in-repo fixtures import workspace source.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../../../index.ts';

export default defineConfig({
  plugins: [
    smrtVitestPlugin({
      verbose: true,
      setupFile: fileURLToPath(new URL('../../../setup.ts', import.meta.url)),
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    testTimeout: 30000,
    pool: 'forks',
    fileParallelism: false,
  },
});
