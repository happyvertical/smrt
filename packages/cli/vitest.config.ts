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
