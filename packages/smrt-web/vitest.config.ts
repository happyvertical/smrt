import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';

// smrt-web tests are pure-function / mocked-fetch (no DB), so they need none of
// the fork isolation the DB packages use. The plugin still runs for the shared
// CI retry policy and workspace-alias conventions.
export default defineConfig({
  // Fixture models live in integration test files. Keep the test manifest
  // focused on package production models so this suite cannot make its
  // decorated classes discoverable to later package tests.
  plugins: [
    smrtVitestPlugin({
      verbose: true,
      exclude: ['**/*.d.ts', '**/node_modules/**', '**/dist/**', '**/*.test.ts'],
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    testTimeout: 30000,
  },
});
