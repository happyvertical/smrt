import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';

// Isolated SSR lane; the existing Commerce suite remains Node/model-only.
export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  plugins: [smrtVitestPlugin(), svelte()],
  test: {
    environment: 'node',
    include: ['test-support/quote-*.spec.ts'],
    fileParallelism: false,
    pool: 'forks',
  },
});
