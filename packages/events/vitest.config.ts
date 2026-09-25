import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';

export default defineConfig({
  plugins: [smrtVitestPlugin({ verbose: true })],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30000,
    // smrt-vitest's async afterAll teardown can exceed the default 10s under
    // loaded CI runners; bump it so a slow teardown doesn't fail the suite.
    hookTimeout: 30000,
    fileParallelism: false,
    pool: 'forks',
    // Recurrence math is local-calendar; fixtures assert UTC instants, so pin
    // the zone or a host whose offset changes between dates fails spuriously.
    env: { TZ: 'UTC' },
  },
});
