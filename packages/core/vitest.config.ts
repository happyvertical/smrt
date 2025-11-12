import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for @happyvertical/smrt-core
 *
 * Uses forks pool with sequential execution to prevent worker timeout issues
 * that occur with threads pool in CI environments.
 *
 * Based on SDK vitest.config.ts which resolved similar issues.
 */
export default defineConfig({
  test: {
    // Include all test file types
    include: ['src/**/*.{test,spec}.{ts,mts}'],

    // Exclude what Vitest shouldn't handle
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/docs/**',
      '**/*.d.ts',
      '**/coverage/**',
    ],

    // Environment configuration
    environment: 'node',

    // Increased timeouts for CI environments
    testTimeout: 30000, // 30 seconds (up from default 5s)
    hookTimeout: 30000, // Match testTimeout for consistency

    // Reporter configuration
    reporters: ['default'],

    // Coverage configuration
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{js,ts}'],
      exclude: [
        'src/**/*.{test,spec}.{js,ts}',
        'src/**/*.d.ts',
        'src/manifest/static-manifest.ts', // Generated file
        'src/manifest/test-manifest-stub.ts', // Generated file
      ],
    },

    // Use forks pool instead of threads to prevent worker timeout issues
    // This matches the SDK configuration that resolved similar problems
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true, // Run tests sequentially to avoid race conditions
        isolate: true, // Isolate tests for proper cleanup
      },
    },

    // Limit to single worker to prevent timeout issues
    maxWorkers: 1,
  },

  // Resolve workspace packages for testing
  resolve: {
    alias: {
      '@happyvertical/smrt-types': resolve(__dirname, '../types/src'),
      '@happyvertical/smrt-config': resolve(__dirname, '../config/src'),
    },
  },
});
