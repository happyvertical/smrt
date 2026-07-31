import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    conditions: ['browser'],
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['@happyvertical/smrt-vitest/svelte-setup'],
    include: ['src/svelte/__tests__/components.test.ts'],
    coverage: {
      provider: 'v8',
      exclude: ['**/__tests__/**', '**/*.{test,spec}.ts', '**/*.d.ts'],
    },
    fileParallelism: false,
    pool: 'forks',
  },
});
