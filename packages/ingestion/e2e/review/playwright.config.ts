import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  workers: 1,
  timeout: 60000,
  outputDir: process.env.CI_TEST_TMPDIR
    ? `${process.env.CI_TEST_TMPDIR}/review-browser-results`
    : '../../test-results/review',
  use: {
    baseURL: 'http://127.0.0.1:5595',
    viewport: { width: 390, height: 844 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? {
          launchOptions: {
            executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          },
        }
      : {}),
  },
  webServer: {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    command:
      'pnpm exec vite --config e2e/review/vite.config.ts --host 127.0.0.1 --port 5595 --strictPort',
    url: 'http://127.0.0.1:5595/e2e/review/index.html',
    reuseExistingServer: false,
    timeout: 60000,
  },
});
