import { defineConfig } from '@playwright/test';

const port = 4173;
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
      'mkdir -p .smrt',
      'rm -f .smrt/e2e-playwright.db',
      `DATABASE_URL=.smrt/e2e-playwright.db pnpm exec vite dev --host 127.0.0.1 --port ${port}`,
    ].join(' && '),
    cwd: new URL('.', import.meta.url).pathname,
    url: baseURL,
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
