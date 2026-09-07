import { coverageConfigDefaults, defineConfig } from 'vitest/config';
import { getWorkspaceViteAliases } from './src/index.ts';

export default defineConfig({
  resolve: {
    alias: getWorkspaceViteAliases(__dirname),
  },
  test: {
    include: ['src/**/*.{test,spec}.{ts,mts}'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.d.ts',
      // Consumer-shaped fixture packages under __tests__/fixtures/ are their
      // own standalone Vitest projects (own vitest.config.ts, own
      // smrtVitestPlugin()/setup wiring) run out-of-process by the tests
      // that exercise them (e.g. issue-2750-registry-shared-across-worker.test.ts)
      // -- never by this package's own top-level `include` glob, which would
      // run their spec files without the fixture's plugin/setup and produce
      // unrelated false failures.
      'src/__tests__/fixtures/**',
    ],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    // This package cannot consume smrtVitestPlugin's injected retry policy
    // while testing the plugin itself. Match core and CLI so transient CI-only
    // timing failures retry without changing local behavior.
    retry: /^\d+$/.test(process.env.SMRT_VITEST_RETRY ?? '')
      ? Number.parseInt(process.env.SMRT_VITEST_RETRY as string, 10)
      : process.env.CI
        ? 2
        : 0,
    // Disable parallelism to avoid race conditions with process.chdir() in tests
    fileParallelism: false,
    coverage: {
      // The Svelte component-test harness (svelte-setup/svelte/a11y) and the
      // manifest setup file are test infrastructure consumed by OTHER packages'
      // tests, not this package's product runtime — exclude them from its
      // coverage floor (S11 #1416), as smrt-svelte excludes its test-support.
      exclude: [
        ...coverageConfigDefaults.exclude,
        'src/svelte.ts',
        'src/svelte-setup.ts',
        'src/a11y.ts',
        'src/setup.ts',
      ],
    },
  },
});
