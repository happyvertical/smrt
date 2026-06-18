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
    alias: viteWorkspaceAliases,
    conditions: ['browser'],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    // Manifest setup + the shared Svelte component-test harness (S11 #1416). The
    // harness only activates under a DOM, so node-environment tests are
    // unaffected; component tests opt in with `// @vitest-environment jsdom`.
    setupFiles: [smrtVitestSetupPath, '@happyvertical/smrt-vitest/svelte-setup'],
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
