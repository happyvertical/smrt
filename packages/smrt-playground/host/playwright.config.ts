import { defineConfig } from '@playwright/test';

const port = 4174;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    headless: true,
  },
  webServer: {
    command: [
      'pnpm exec svelte-kit sync',
      `pnpm exec vite dev --host 127.0.0.1 --port ${port}`,
    ].join(' && '),
    cwd: new URL('.', import.meta.url).pathname,
    url: baseURL,
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
