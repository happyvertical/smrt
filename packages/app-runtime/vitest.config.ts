import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import {
  smrtVitestPlugin,
  smrtVitestSetupPath,
} from '../../vitest.workspace.js';

export default defineConfig({
  // Package self-references must share the source identities under test,
  // while the production fixture deliberately exercises built exports.
  resolve: {
    alias: [
      {
        find: /^@happyvertical\/smrt-app-runtime$/,
        replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      },
      {
        find: '@happyvertical/smrt-app-runtime/sveltekit-runtime',
        replacement: fileURLToPath(
          new URL('./src/sveltekit-runtime.ts', import.meta.url),
        ),
      },
    ],
  },
  plugins: [smrtVitestPlugin({ setupFile: smrtVitestSetupPath })],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    setupFiles: [smrtVitestSetupPath],
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
    pool: 'forks',
  },
});
