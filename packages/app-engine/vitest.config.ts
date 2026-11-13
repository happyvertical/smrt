import { defineConfig } from 'vitest/config';
import {
  smrtVitestPlugin,
  smrtVitestSetupPath,
} from '../../vitest.workspace.js';

export default defineConfig({
  plugins: [smrtVitestPlugin({ setupFile: smrtVitestSetupPath })],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Component tests run under vitest.dom.config.ts (jsdom + Svelte).
    exclude: ['**/node_modules/**', 'src/**/*.dom.test.ts'],
    setupFiles: [smrtVitestSetupPath],
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
    pool: 'forks',
  },
});
