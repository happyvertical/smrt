import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';

export default defineConfig({
  plugins: [smrtVitestPlugin({ verbose: true }), svelte({ hot: false })],
  // Resolve Svelte's `browser` export condition so `mount` / `unmount` resolve
  // to the client runtime under jsdom (mirrors smrt-svelte's config).
  resolve: {
    conditions: ['browser'],
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-support/setup.ts'],
    include: ['src/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      exclude: [
        '**/__tests__/**',
        '**/*.{test,spec}.ts',
        'src/test-support/**',
        '**/*.d.ts',
      ],
    },
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
