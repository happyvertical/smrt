// The packed-tarball start test (#5494): needs a built package (`pnpm build`).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/packed-start.test.ts'],
    testTimeout: 120000,
    hookTimeout: 120000,
    pool: 'forks',
  },
});
