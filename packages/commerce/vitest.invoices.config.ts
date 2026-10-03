import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';

export default defineConfig({
  plugins: [svelte(), smrtVitestPlugin({ verbose: false })],
  test: {
    environment: 'node',
    include: ['src/svelte/invoices/**/*.spec.ts'],
    fileParallelism: false,
    pool: 'forks',
  },
});
