import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    // CI runners are slower. The cli tests do dynamic imports and
    // `require.resolve` of workspace packages (e.g. npm-loader.spec's
    // `resolveNpmPackage`), which intermittently exceeded the default 5s under
    // load — surfacing as a flaky "Test timed out in 5000ms" in the Test
    // Packages job (passed on re-run). Match the other heavy packages'
    // CI-safe timeouts. hookTimeout too, since beforeEach/afterAll can be slow.
    testTimeout: 30000,
    hookTimeout: 30000,
    // Re-run a failed test in CI before failing the run (same policy as
    // smrt-vitest's resolveCiRetry). cli does not use smrtVitestPlugin, so the
    // retry is set inline here. Some cli tests (e.g. db:migrate atomic rollback)
    // have rare CI-only timing flakes that pass on re-run; retry keeps the
    // shared "Test Packages" job reliable without masking real failures (a
    // deterministic failure still fails all attempts). Local runs keep retry at
    // 0 so flakes stay visible; override with SMRT_VITEST_RETRY=<n>.
    retry: /^\d+$/.test(process.env.SMRT_VITEST_RETRY ?? '')
      ? Number.parseInt(process.env.SMRT_VITEST_RETRY as string, 10)
      : process.env.CI
        ? 2
        : 0,
    // Coverage scope: cli does not use smrtVitestPlugin (which supplies this for
    // other packages), and its tests self-import the built `@happyvertical/smrt-cli`
    // (→ dist/), so without an explicit scope the v8 provider counted the dist
    // bundle and reported a misleadingly low package coverage. Restrict to source.
    coverage: {
      include: ['src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/__tests__/**',
        '**/*.d.ts',
      ],
    },
  },
  resolve: {
    alias: [
      {
        find: /^@happyvertical\/smrt-agents$/,
        replacement: resolve(__dirname, '../agents/src/index.ts'),
      },
    ],
  },
});
