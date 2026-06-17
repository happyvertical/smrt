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
      // Cross-package integration tests that traverse the entire monorepo.
      // These are run locally or in a dedicated CI step, not in sharded runs.
      ...(process.env.TEST_INTEGRATION ? [] : [
        'src/__tests__/full-registry-integration.test.ts',
        'src/__tests__/manifest-no-leak.test.ts',
      ]),
    ],

    // Environment configuration
    environment: 'node',
    setupFiles: [resolve(__dirname, '../vitest/src/setup.ts')],

    // Increased timeouts for CI environments
    testTimeout: 60000, // 60 seconds for slow CI
    hookTimeout: 120000, // Hooks can include module setup in constrained CI
    teardownTimeout: 60000, // Allow time for cleanup
    // Re-run a failed test in CI before failing the run (same policy as
    // smrt-vitest's resolveCiRetry). core does not use smrtVitestPlugin, so the
    // retry is set inline. Keeps the sharded Test Core job resilient to rare
    // CI-only timing flakes that pass on re-run; local runs keep retry at 0.
    // Override with SMRT_VITEST_RETRY=<n>.
    retry: /^\d+$/.test(process.env.SMRT_VITEST_RETRY ?? '')
      ? Number.parseInt(process.env.SMRT_VITEST_RETRY as string, 10)
      : process.env.CI
        ? 2
        : 0,

    // Reporter configuration
    reporters: ['default'],

    // Coverage configuration
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{js,ts}'],
      exclude: [
        'src/**/*.{test,spec}.{js,ts}',
        'src/**/*.d.ts',
        'src/manifest/test-manifest-stub.ts', // Generated file
      ],
    },

    // Use forks pool instead of threads to prevent worker timeout issues
    // This matches the SDK configuration that resolved similar problems.
    pool: 'forks',
    isolate: true,

    // Limit to single worker to prevent timeout issues
    maxWorkers: 1,

    // Disable file parallelism to prevent RPC timeout issues
    fileParallelism: false,
  },

  // Resolve workspace packages for testing
  resolve: {
    alias: {
      '@happyvertical/smrt-types': resolve(__dirname, '../types/src'),
      '@happyvertical/smrt-config': resolve(__dirname, '../config/src'),
    },
  },
});
