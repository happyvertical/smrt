import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';
export default defineConfig({ plugins: [smrtVitestPlugin()], test: { include: ['src/**/*.test.ts'], testTimeout: 30000, fileParallelism: false, pool: 'forks' } });
