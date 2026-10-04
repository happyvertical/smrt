import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4185',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } }
      : {}),
  },
  webServer: {
    command: 'pnpm exec vite --config e2e/vite.config.ts --host 127.0.0.1 --port 4185',
    url: 'http://127.0.0.1:4185/e2e/feedback.html',
    reuseExistingServer: false,
  },
});
