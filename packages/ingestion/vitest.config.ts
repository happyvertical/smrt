import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';
export default defineConfig({ plugins: [smrtVitestPlugin()], test: { include: ['src/**/*.test.ts'], exclude: ['src/**/*.postgres.test.ts', 'src/svelte/**'], fileParallelism: false, testTimeout: 30000, hookTimeout: 60000, coverage: { provider: 'v8', reporter: ['text', 'json', 'html'], exclude: ['src/test-support/**', 'src/**/*.test.ts', 'src/__smrt-register__.ts'] } } });
