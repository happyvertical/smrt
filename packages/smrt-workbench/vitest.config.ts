import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';

export default defineConfig({
  plugins: [smrtVitestPlugin({ verbose: true })],
  test: {
    // One test file at a time: keeps concurrent agent worktrees within memory (TESTING_STANDARD.md, standards.md).
    fileParallelism: false,
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}'],
    exclude: ['host/**'],
  },
});
