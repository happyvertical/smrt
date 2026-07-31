import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';

export default defineConfig({
  plugins: [smrtVitestPlugin({ verbose: true })],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30000,
    fileParallelism: false,
    pool: 'forks',
    // Reuse one fork per package so the SMRT manifest and base-class
    // graph load once instead of once per test file.
    isolate: false,
  },
});
