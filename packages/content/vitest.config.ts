import { resolve } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '@happyvertical/smrt-vitest';

export default defineConfig({
  plugins: [svelte(), smrtVitestPlugin()],
  resolve: {
    alias: {
      $lib: resolve(__dirname, 'src/lib'),
      '@happyvertical/smrt-facts': resolve(__dirname, 'src/workspace-facts.ts'),
    },
    conditions: ['browser'],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    setupFiles: ['@happyvertical/smrt-vitest/setup'],
    testTimeout: 30000,
    fileParallelism: false,
    pool: 'forks',
    singleFork: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 60,
      },
      exclude: ['**/*.test.ts', '**/*.spec.ts', '**/node_modules/**'],
    },
  },
});
