import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';

export default defineConfig({
  plugins: [smrtVitestPlugin({ verbose: true }), svelte({ hot: false })],
  // Resolve Svelte's `browser` export condition so `mount` / `unmount` resolve
  // to the client runtime under jsdom (mirrors smrt-svelte / chat configs). The
  // smrt-vitest plugin auto-applies the workspace package→src aliases in its
  // config() hook, so no manual alias list is needed here.
  resolve: {
    conditions: ['browser'],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The shared Svelte component-test harness (S11 #1416). The harness only
    // activates under a DOM, so node-environment tests are unaffected; the
    // agent-admin shell component tests opt in with `// @vitest-environment
    // jsdom`.
    setupFiles: ['@happyvertical/smrt-vitest/svelte-setup'],
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
