import { resolve } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import {
  smrtVitestPlugin,
  smrtVitestSetupPath,
} from '../../vitest.workspace.js';
import { viteWorkspaceAliases } from './workspace-aliases.js';

export default defineConfig({
  plugins: [svelte(), smrtVitestPlugin({ setupFile: smrtVitestSetupPath })],
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
    setupFiles: [smrtVitestSetupPath],
    testTimeout: 30000,
    // The smrt-vitest setup's async afterAll dynamically loads smrt-core; under
    // loaded CI runners that exceeds the default 10s hookTimeout and times out
    // the suite even though all test bodies pass (the ContentEditor flake).
    hookTimeout: 30000,
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
