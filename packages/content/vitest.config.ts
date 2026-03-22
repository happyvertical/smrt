import { resolve } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '@happyvertical/smrt-vitest';
import { viteWorkspaceAliases } from './workspace-aliases.js';

export default defineConfig({
  plugins: [svelte(), smrtVitestPlugin()],
  resolve: {
    alias: [
      {
        find: '$lib',
        replacement: resolve(__dirname, 'src/lib'),
      },
      ...viteWorkspaceAliases,
    ],
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
