import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Template sources import via SvelteKit's `$lib` alias; resolve it to
      // the template's lib directory so tests can import route modules.
      $lib: resolve(__dirname, 'template/src/lib'),
      // `@sveltejs/kit` is a dependency of scaffolded consumer projects, not
      // of this package. Route modules import runtime helpers (`fail`) from
      // it, so tests resolve it to a minimal behavioral stub.
      '@sveltejs/kit': resolve(__dirname, '__tests__/setup/sveltejs-kit-stub.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    // Tests live in `__tests__/` (outside `template/`) so they aren't
    // copied into consumer projects by `copyTemplate()`. They import the
    // template source directly to verify behavior.
    include: ['__tests__/**/*.test.ts'],
    // The template's tsconfig extends `./.svelte-kit/tsconfig.json`, which
    // only exists after a consumer runs `svelte-kit sync`. This setup
    // writes a minimal stub before tests run and removes it after.
    globalSetup: ['./__tests__/setup/svelte-kit-stub.ts'],
    // CI runners are slow and the server-load test walks the real
    // collection bootstrap path (registry + sqlite) before failing over.
    // The hook timeout covers its beforeAll, which imports smrt-core.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
