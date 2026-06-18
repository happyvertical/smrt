import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import {
  smrtVitestPlugin,
  smrtVitestSetupPath,
} from '../../vitest.workspace.js';
import { viteWorkspaceAliases } from './workspace-aliases.js';

export default defineConfig({
  plugins: [
    svelte(),
    smrtVitestPlugin({
      setupFile: smrtVitestSetupPath,
      verbose: true,
    }),
  ],
  resolve: {
    alias: viteWorkspaceAliases,
    conditions: ['browser'],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    setupFiles: [smrtVitestSetupPath],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    coverage: {
      // Exclude @smrt/core-generated code from the coverage denominator: the
      // SvelteKit route handlers (gitignored, "Auto-generated … DO NOT EDIT")
      // and the generated server-config glue. They are framework codegen, not
      // authored logic, so they only deflate the signal — the package's own
      // models/services/editor are what the gate should measure.
      exclude: [
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/node_modules/**',
        // v8 cannot meaningfully instrument compiled `.svelte` output (the same
        // reason smrt-svelte is exempt from the coverage gate); component logic
        // is covered by the jsdom component-test harness, not line coverage.
        '**/*.svelte',
        // @smrt/core-generated codegen (route handlers + server-config glue),
        // not authored logic.
        'src/routes/**',
        'src/lib/server/**',
        'src/route-module.ts',
      ],
    },
  },
});
