import { defineConfig } from '@playwright/test';

const port = 5582;
const chromiumExecutablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
export default defineConfig({
  testDir: './party-browser',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
    ...(chromiumExecutablePath
      ? { launchOptions: { executablePath: chromiumExecutablePath } }
      : {}),
  },
  webServer: {
    command: `pnpm exec vite --config party-browser/vite.config.ts --host 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
