import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';

export default defineConfig({
  plugins: [smrtVitestPlugin({ verbose: true })],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30000,
    // Hooks never inherit testTimeout; manifest generation happens in setup.
    hookTimeout: 30000,
    fileParallelism: false,
    pool: 'forks',
  },
});
