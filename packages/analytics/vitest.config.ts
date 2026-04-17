import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';

/**
 * Vitest configuration for @happyvertical/smrt-analytics
 *
 * Multi-adapter testing using Vitest 4.x projects.
 * Runs the same tests against SQLite, PostgreSQL, and JSON (DuckDB) adapters.
 * PostgreSQL tests will be skipped gracefully if PG is not available.
 *
 * Usage:
 *   npm test              - Runs all adapters
 *   npm run test:sqlite   - Runs only SQLite tests
 *   npm run test:postgres - Runs only PostgreSQL tests
 *   npm run test:json     - Runs only JSON tests
 */
export default defineConfig({
  plugins: [smrtVitestPlugin({ verbose: true })],
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
    fileParallelism: false,
    // Vitest 4.x: pool options are now top-level
    pool: 'forks',
    singleFork: true,
    // Multi-adapter test projects (Vitest 4.x)
    projects: [
      {
        test: {
          name: 'sqlite',
          include: ['src/**/*.test.ts'],
          env: {
            TEST_DB_ADAPTER: 'sqlite',
          },
        },
      },
      {
        test: {
          name: 'postgres',
          include: ['src/**/*.test.ts'],
          env: {
            TEST_DB_ADAPTER: 'postgres',
            TEST_DB_URL:
              process.env.DATABASE_URL ||
              'postgresql://postgres:postgres@localhost:5432/test_db',
          },
        },
      },
      {
        test: {
          name: 'json',
          include: ['src/**/*.test.ts'],
          env: {
            TEST_DB_ADAPTER: 'json',
          },
        },
      },
    ],
  },
});
