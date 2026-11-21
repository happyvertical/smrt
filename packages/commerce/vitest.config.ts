import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';

// The SQLite adapter (external @happyvertical/sql) console.logs every schema
// statement unconditionally. Hide that per-statement trace unless the developer
// opts in with SMRT_VERBOSE=true or DEBUG=smrt*; errors (stderr) always surface.
const showSchemaSyncTrace =
  process.env.SMRT_VERBOSE === 'true' ||
  (process.env.DEBUG ?? '').includes('smrt');

export default defineConfig({
  plugins: [smrtVitestPlugin({ verbose: true })],
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
    testTimeout: 30000,
    hookTimeout: 30000,
    // Run test files sequentially to avoid SQLite locking issues
    fileParallelism: false,
    // Use single-threaded pool to avoid database contention
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['**/*.test.ts', '**/*.spec.ts', '**/node_modules/**'],
    },
  },
});
