import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';

export default defineConfig({
  plugins: [smrtVitestPlugin({ verbose: true }), svelte({ hot: false })],
  resolve: { conditions: ['browser'] },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['@happyvertical/smrt-vitest/svelte-setup'],
    fileParallelism: false,
    pool: 'forks',
    singleFork: true,
  },
});
