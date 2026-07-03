import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';

// smrt-web tests are pure-function / mocked-fetch (no DB), so they need none of
// the fork isolation the DB packages use. The plugin still runs for the shared
// CI retry policy and workspace-alias conventions.
export default defineConfig({
  plugins: [smrtVitestPlugin({ verbose: true })],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    testTimeout: 30000,
  },
});
