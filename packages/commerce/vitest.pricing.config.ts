import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';
export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  plugins: [smrtVitestPlugin(), svelte()],
  test: { environment: 'node', include: ['test-support/pricing-*.spec.ts'], fileParallelism: false, pool: 'forks' },
});
