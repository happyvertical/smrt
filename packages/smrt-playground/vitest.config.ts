import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [svelte({ compilerOptions: { css: 'external' } })],
  test: {
    // One test file at a time: keeps concurrent agent worktrees within memory (TESTING_STANDARD.md, standards.md).
    fileParallelism: false,
    globalSetup: ['../vitest/src/test-home.global-setup.ts'],
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}'],
    exclude: ['host/**'],
  },
});
