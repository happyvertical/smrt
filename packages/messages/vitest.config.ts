import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';

export default defineConfig({
  plugins: [smrtVitestPlugin()],
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [resolve(__dirname, '../vitest/src/setup.ts')],
  },
});
