import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';
export default defineConfig({ plugins: [smrtVitestPlugin()], test: { include: ['src/**/*.postgres.test.ts'], fileParallelism: false, testTimeout: 30000, hookTimeout: 60000 } });
