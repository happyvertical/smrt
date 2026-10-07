import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';

// Behaviour tests for the customer and vendor selectors need a DOM, so they
// run under jsdom with Svelte's client runtime (the `browser` condition).
export default defineConfig({
  plugins: [smrtVitestPlugin(), svelte()],
  resolve: { conditions: ['browser'] },
  test: {
    environment: 'jsdom',
    include: ['select-tests/**/*.dom.ts'],
    setupFiles: ['@happyvertical/smrt-ui/test-support/setup'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
