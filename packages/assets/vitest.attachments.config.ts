import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';
export default defineConfig({
  plugins: [svelte(), smrtVitestPlugin({ verbose: false })],
  // Match this package's main suite for manifest setup; keep test body limits unchanged.
  test: { environment: 'node', include: ['src/svelte/attachments/**/*.contract.ts'], hookTimeout: 30000, fileParallelism: false, pool: 'forks' },
});
