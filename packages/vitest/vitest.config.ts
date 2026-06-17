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
    ],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
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
