import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';

export default defineConfig({
  plugins: [smrtVitestPlugin({ verbose: true }), svelte()],
  resolve: { conditions: ['browser'] },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30000,
    fileParallelism: false,
    pool: 'forks',
    setupFiles: ['@happyvertical/smrt-vitest/svelte-setup'],
    coverage: { provider: 'v8', reporter: ['text', 'json', 'html'] },
  },
});
