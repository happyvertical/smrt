import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { smrtVitestPlugin } from '../vitest/src/index.ts';

export default defineConfig({
  plugins: [smrtVitestPlugin({ verbose: true }), svelte({ hot: false })],
  // Resolve Svelte's `browser` export condition so that `mount` / `unmount`
  // resolve to the client runtime under jsdom. Without this, `svelte`'s
  // package exports fall through to `default: index-server.js`, which makes
  // `mount(...)` unavailable in tests.
  //
  // NOTE: Forcing the `browser` condition globally masks the SSR path. Any
  // future test in this package that needs to exercise Svelte's server
  // runtime (e.g. asserting SSR HTML output of a component, or covering
  // `$effect.root` boundaries that differ between client/server) will need
  // a scoped override — either a dedicated vitest project (workspace) with
  // its own `resolve.conditions`, or a path filter on this `conditions`
  // setting. Until that need arises, keeping `['browser']` everywhere is
  // the simplest way to keep the client-side workspace primitive tests
  // green under jsdom.
  resolve: {
    conditions: ['browser'],
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.ts'],
    testTimeout: 30000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
