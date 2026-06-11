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
    // Component golden-test harness (L4 #1423): jest-dom matchers + Testing
    // Library auto-cleanup. The smrt-vitest plugin appends its own setup file
    // to this list (it merges rather than overrides).
    setupFiles: ['./src/test-support/setup.ts'],
    include: ['src/**/*.{test,spec}.ts'],
    testTimeout: 30000,
    // Match testTimeout. The smrt-vitest setup file
    // (`@happyvertical/smrt-vitest/setup`) registers an async `afterAll` that
    // dynamically loads `@happyvertical/smrt-core`'s table-cache module
    // (falling back to a tsx on-the-fly transpile of the core source when the
    // built export isn't resolvable in the worker). That module work is fast
    // locally but can exceed the 10s `hookTimeout` default in constrained CI —
    // where this package's two largest suites (RoleShell, define-tools-dock)
    // timed out the teardown hook even though every test body passed
    // (issue #1426). Other packages hitting the same setup hook already raise
    // this (core: 120000; ads/assets/ledgers/products/vitest: 30000+);
    // smrt-svelte previously bumped only testTimeout and left hookTimeout at
    // the default. Surfaced repo-wide by the Vitest 4 upgrade shifting test
    // isolation/contention timing.
    hookTimeout: 30000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
