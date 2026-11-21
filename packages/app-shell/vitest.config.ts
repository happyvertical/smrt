import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import {
  smrtVitestPlugin,
  smrtVitestSetupPath,
} from '../../vitest.workspace.js';

export default defineConfig({
  plugins: [smrtVitestPlugin({ setupFile: smrtVitestSetupPath })],
  resolve: {
    // SvelteKit's `$lib`, for the route modules under test.
    alias: { $lib: fileURLToPath(new URL('./src/lib', import.meta.url)) },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Component tests run under vitest.dom.config.ts (jsdom + Svelte).
    exclude: [
      '**/node_modules/**',
      'src/**/*.dom.test.ts',
      // The engine on a database server: PGlite and, in CI, a real server,
      // from `pnpm test:postgres` (vitest.postgres.config.ts), once.
      'src/engine/postgres-server.test.ts',
      'src/engine/postgres-drafts.test.ts',
      'src/engine/portable-export-postgres.test.ts',
      'src/engine/postgres-claim-connection.test.ts',
      'src/engine/store-in-swap.test.ts',
      'src/lib/server/storage-metering-postgres.test.ts',
      'src/lib/server/hosted-inference-postgres.test.ts',
      'src/engine/postgres-feed-stream.test.ts',
    ],
    setupFiles: [smrtVitestSetupPath],
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
    pool: 'forks',
  },
});
