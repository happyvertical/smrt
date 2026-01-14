import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '@happyvertical/smrt-vitest';

export default defineConfig({
  plugins: [smrtVitestPlugin()],
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['@happyvertical/smrt-vitest/setup'],
  },
});
