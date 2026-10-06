import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [svelte()],
  resolve: { conditions: ['browser'] },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/svelte/__tests__/lead-components.test.ts'],
    testTimeout: 30000,
    fileParallelism: false,
    pool: 'forks',
  },
});
