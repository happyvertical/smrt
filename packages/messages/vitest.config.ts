import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';

export default defineConfig({
  plugins: [smrtVitestPlugin()],
  test: {
    // One test file at a time: keeps concurrent agent worktrees within memory (TESTING_STANDARD.md, standards.md).
    fileParallelism: false,
    globals: true,
    environment: 'node',
    setupFiles: [resolve(__dirname, '../vitest/src/setup.ts')],
  },
});
