import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';

export default defineConfig({
  plugins: [smrtVitestPlugin({ verbose: true }), svelte({ hot: false })],
  // Resolve Svelte's `browser` export condition so mount/unmount resolve to
  // the client runtime under jsdom (mirrors agents/assets configs).
  resolve: {
    conditions: ['browser'],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 60000,
    fileParallelism: false,
    pool: 'forks',
    singleFork: true,
    // The shared Svelte component-test harness (S11 #1416). Only activates
    // under a DOM, so node-environment tests are unaffected; component tests
    // opt in with `// @vitest-environment jsdom`.
    setupFiles: ['@happyvertical/smrt-vitest/svelte-setup'],
  },
});
