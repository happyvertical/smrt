import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  workers: 1,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:47851',
    hasTouch: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command:
      'pnpm exec vite --config e2e/vite.config.ts --host 127.0.0.1 --port 47851 --strictPort',
    cwd: new URL('..', import.meta.url).pathname,
    url: 'http://127.0.0.1:47851',
    reuseExistingServer: false,
  },
});
