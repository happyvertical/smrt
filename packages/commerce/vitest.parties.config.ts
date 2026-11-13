import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';

export default defineConfig({
  plugins: [smrtVitestPlugin(), svelte()],
  test: {
    environment: 'node', testTimeout: 30000, hookTimeout: 30000,
    include: ['src/svelte/**/*.spec.ts'],
  },
});
