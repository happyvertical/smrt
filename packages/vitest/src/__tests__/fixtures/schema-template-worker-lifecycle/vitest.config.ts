import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packageSource = new URL('../../../', import.meta.url);

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    setupFiles: [fileURLToPath(new URL('setup.ts', packageSource))],
    pool: process.env.SMRT_TEMPLATE_POOL === 'threads' ? 'threads' : 'forks',
    fileParallelism: false,
  },
});
