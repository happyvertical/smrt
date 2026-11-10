import { defineConfig } from '@playwright/test';

const port = Number(process.env.SMRT_CONTENT_E2E_PORT ?? 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('SMRT_CONTENT_E2E_PORT must be an integer from 1 to 65535');
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
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } }
      : {}),
  },
  webServer: {
    command: [
      'mkdir -p .smrt',
      'rm -f .smrt/e2e-playwright.db',
      'DATABASE_URL=.smrt/e2e-playwright.db pnpm exec vite build',
      `DATABASE_URL=.smrt/e2e-playwright.db pnpm exec vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    ].join(' && '),
    cwd: new URL('.', import.meta.url).pathname,
    url: baseURL,
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
