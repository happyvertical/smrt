import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';

export default defineConfig({
  plugins: [smrtVitestPlugin({ verbose: true }), svelte({ hot: false })],
  // Svelte's `browser` condition so `mount` resolves to the client runtime
  // under jsdom (mirrors the agents / chat configs).
  resolve: {
    conditions: ['browser'],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Component tests opt into the DOM with `// @vitest-environment jsdom`;
    // the harness is inert under the node environment.
    setupFiles: ['@happyvertical/smrt-vitest/svelte-setup'],
    testTimeout: 30000,
    fileParallelism: false,
    pool: 'forks',
  },
});
