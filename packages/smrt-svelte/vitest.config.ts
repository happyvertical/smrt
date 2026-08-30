import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { smrtVitestPlugin } from '../vitest/src/index.ts';

// This integration gate intentionally consumes the published package entry
// points. Vite's workspace symlink resolver otherwise follows those imports
// back to sibling `src/` files, whose source-mode manifest URL is not a valid
// browser URL under strict registry diagnostics. Keep the aliases limited to
// this package's test runner; production builds retain normal package exports.
const built = (packageName: string, entry: string) =>
  fileURLToPath(new URL(`../${packageName}/dist/${entry}`, import.meta.url));

export default defineConfig({
  plugins: [
    smrtVitestPlugin({
      verbose: true,
      // The test is a published-entry compatibility gate. Avoid source-mode
      // base-class discovery, which imports workspace siblings a second time
      // and creates strict-registry constructor collisions with their built
      // exports. The built workspace manifests are loaded below instead.
      generateManifest: false,
      aliasFilter: ({ find }) =>
        ![
          '@happyvertical/smrt-agents',
          '@happyvertical/smrt-agents/server',
          '@happyvertical/smrt-assets',
          '@happyvertical/smrt-chat/data-surface-bridge',
          '@happyvertical/smrt-content/svelte',
          '@happyvertical/smrt-config',
          '@happyvertical/smrt-jobs',
          '@happyvertical/smrt-profiles',
          '@happyvertical/smrt-profiles/internal/oidc-provisioning',
          '@happyvertical/smrt-prompts',
          '@happyvertical/smrt-reports',
          '@happyvertical/smrt-secrets',
          '@happyvertical/smrt-tags',
          '@happyvertical/smrt-tenancy',
          '@happyvertical/smrt-users',
        ].includes(find),
      // The composed WebMCP fixture declares decorated test-only models. Keep
      // them out of the package manifest so other workers cannot discover
      // fixture classes; the integration test runs its own explicit scanner
      // pass for the generated descriptor.
      exclude: ['**/*.d.ts', '**/node_modules/**', '**/dist/**', '**/*.test.ts'],
    }),
    svelte({ hot: false }),
  ],
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
    alias: {
      '@happyvertical/smrt-agents/server': built('agents', 'server.js'),
      '@happyvertical/smrt-agents': built('agents', 'index.js'),
      '@happyvertical/smrt-assets': built('assets', 'index.js'),
      '@happyvertical/smrt-chat/data-surface-bridge': built(
        'chat',
        'data-surface-bridge.js',
      ),
      '@happyvertical/smrt-content/svelte': built(
        'content',
        'svelte/index.js',
      ),
      '@happyvertical/smrt-config': built('config', 'index.js'),
      '@happyvertical/smrt-jobs': built('jobs', 'index.js'),
      '@happyvertical/smrt-profiles/internal/oidc-provisioning': built(
        'profiles',
        'internal/oidc-provisioning.js',
      ),
      '@happyvertical/smrt-profiles': built('profiles', 'index.js'),
      '@happyvertical/smrt-prompts': built('prompts', 'index.js'),
      '@happyvertical/smrt-reports': built('reports', 'index.js'),
      '@happyvertical/smrt-secrets': built('secrets', 'index.js'),
      '@happyvertical/smrt-tags': built('tags', 'index.js'),
      '@happyvertical/smrt-tenancy': built('tenancy', 'index.js'),
      '@happyvertical/smrt-users': built('users', 'index.js'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    // Component golden-test harness (L4 #1423): jest-dom matchers + Testing
    // Library auto-cleanup. The harness moved to the smrt-ui leaf (#1582); we
    // consume it via the package's test-support export. The smrt-vitest plugin
    // appends its own setup file to this list (it merges rather than overrides).
    setupFiles: ['@happyvertical/smrt-ui/test-support/setup'],
    include: ['src/**/*.{test,spec}.ts'],
    // Coverage scope for the per-tier gate (S6 #1411): measure shipped source
    // only. Test infrastructure (fixtures, the test-support harness, *.test.ts)
    // is not product code and must not count toward the floor. v8 can't
    // instrument `.svelte`, so the measured surface is the package's `.ts`.
    coverage: {
      provider: 'v8',
      exclude: [
        '**/__tests__/**',
        '**/*.{test,spec}.ts',
        'src/test-support/**',
        '**/*.d.ts',
      ],
    },
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
  },
});
