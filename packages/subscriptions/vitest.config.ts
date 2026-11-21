import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';

// The SQLite adapter (external @happyvertical/sql) console.logs every schema
// statement unconditionally. Hide that per-statement trace unless the developer
// opts in with SMRT_VERBOSE=true or DEBUG=smrt*; errors (stderr) always surface.
const showSchemaSyncTrace =
  process.env.SMRT_VERBOSE === 'true' ||
  (process.env.DEBUG ?? '').includes('smrt');

export default defineConfig({
  plugins: [smrtVitestPlugin({ verbose: true }), svelte()],
  test: {
    onConsoleLog(log, type) {
      if (
        !showSchemaSyncTrace &&
        type === 'stdout' &&
        log.startsWith('[sqlite.syncSchema]')
      ) {
        return false;
      }
    },
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
    pool: 'forks',
  },
});
