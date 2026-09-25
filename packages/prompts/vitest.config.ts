import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';

/**
 * Two projects, because the two halves of this package need incompatible
 * module resolution. The server suites run against `@happyvertical/smrt-core`'s
 * Node entry; the `./svelte` component suites need Svelte's `browser`
 * condition so `mount`/`unmount` resolve to the client runtime under jsdom, and
 * that same condition would send smrt-core to its browser build.
 */
export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000,
    fileParallelism: false,
    pool: 'forks',
    projects: [
      {
        plugins: [smrtVitestPlugin({ verbose: true })],
        test: {
          name: 'server',
          globals: true,
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/svelte/**'],
          testTimeout: 30000,
          fileParallelism: false,
          pool: 'forks',
        },
      },
      {
        plugins: [svelte()],
        resolve: {
          conditions: ['browser'],
        },
        test: {
          name: 'svelte',
          globals: true,
          environment: 'jsdom',
          include: ['src/svelte/**/*.test.ts'],
          testTimeout: 30000,
          fileParallelism: false,
          pool: 'forks',
        },
      },
    ],
  },
});
