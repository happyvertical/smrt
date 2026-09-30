import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: '*.spec.ts', workers: 1, retries: 0,
  use: { baseURL: 'http://127.0.0.1:47865', trace: 'retain-on-failure' },
  webServer: { command: 'node e2e/server.mjs', cwd: new URL('..', import.meta.url).pathname, url: 'http://127.0.0.1:47865', reuseExistingServer: false },
});
