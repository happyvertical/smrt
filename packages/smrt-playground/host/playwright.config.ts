import { defineConfig } from '@playwright/test';

const port = 4174;
const localBaseURL = `http://127.0.0.1:${port}`;
const externalBaseURL = process.env.PLAYWRIGHT_BASE_URL?.trim();
const chromiumExecutablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();

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
    baseURL: externalBaseURL || localBaseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    headless: true,
    ...(chromiumExecutablePath
      ? { launchOptions: { executablePath: chromiumExecutablePath } }
      : {}),
  },
  ...(externalBaseURL
    ? {}
    : {
        webServer: {
          command: [
            'pnpm exec svelte-kit sync',
            `pnpm exec vite dev --host 127.0.0.1 --port ${port}`,
          ].join(' && '),
          cwd: new URL('.', import.meta.url).pathname,
          url: localBaseURL,
          timeout: 120_000,
          reuseExistingServer: false,
        },
      }),
});
