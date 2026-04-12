import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
  },
  resolve: {
    alias: [
      {
        find: /^@happyvertical\/smrt-agents$/,
        replacement: resolve(__dirname, '../agents/src/index.ts'),
      },
    ],
  },
});
