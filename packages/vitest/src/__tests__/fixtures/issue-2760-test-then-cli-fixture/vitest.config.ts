/**
 * Consumer-shaped fixture for #2760: a package whose test file declares a
 * full-CRUD inline fixture (`ConvNote`, the shape that leaked from
 * `packages/chat`). The outer test runs this suite, then reads the package
 * the way CLI generation and `db:status --parity` do, in a process outside
 * the run. Imports the plugin from workspace source (as the #2750 fixture does).
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
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    fileParallelism: false,
  },
});
