import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import {
  smrtVitestPlugin,
  smrtVitestSetupPath,
} from '../../vitest.workspace.js';

const root = resolve(__dirname, '../..');

export default defineConfig({
  plugins: [smrtVitestPlugin({ setupFile: smrtVitestSetupPath })],
  resolve: {
    alias: {
      '@happyvertical/smrt-assets': resolve(root, 'packages/assets/src/index.ts'),
      '@happyvertical/smrt-config': resolve(root, 'packages/config/src/index.ts'),
      '@happyvertical/smrt-core/testing': resolve(root, 'packages/core/src/testing/index.ts'),
      '@happyvertical/smrt-core': resolve(root, 'packages/core/src/index.ts'),
      '@happyvertical/smrt-tags': resolve(root, 'packages/tags/src/index.ts'),
      '@happyvertical/smrt-tenancy': resolve(root, 'packages/tenancy/src/index.ts'),
      '@happyvertical/smrt-types': resolve(root, 'packages/types/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    setupFiles: [smrtVitestSetupPath],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
