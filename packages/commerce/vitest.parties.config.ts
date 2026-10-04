import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';

export default defineConfig({
  plugins: [smrtVitestPlugin(), svelte()],
  test: {
    environment: 'node',
    include: ['src/svelte/**/*.spec.ts'],
  },
});
