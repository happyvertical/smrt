import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import {
  smrtVitestPlugin,
  smrtVitestSetupPath,
} from '../../vitest.workspace.js';

export default defineConfig({
  plugins: [svelte(), smrtVitestPlugin({ setupFile: smrtVitestSetupPath })],
  // The smrt-vitest plugin auto-applies the workspace package→src aliases in
  // its config() hook; only the browser resolve conditions are needed here so
  // Svelte component tests resolve the client runtime.
  resolve: {
    conditions: ['browser'],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    // Manifest setup + the shared Svelte component-test harness (S11 #1416).
    // The harness only activates under a DOM; component tests opt in with
    // `// @vitest-environment jsdom`.
    setupFiles: [smrtVitestSetupPath, '@happyvertical/smrt-vitest/svelte-setup'],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
    pool: 'forks',
  },
});
