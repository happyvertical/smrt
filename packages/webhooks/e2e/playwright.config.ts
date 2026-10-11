import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: '*.spec.ts', workers: 1,
  outputDir: process.env.CI_TEST_TMPDIR ? `${process.env.CI_TEST_TMPDIR}/webhooks-browser-results` : '../test-results',
  use: { baseURL: 'http://127.0.0.1:5617', trace: 'retain-on-failure', screenshot: 'only-on-failure',
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } } : {}) },
  webServer: { cwd: fileURLToPath(new URL('../', import.meta.url)), command: 'pnpm exec vite --config e2e/vite.config.ts --host 127.0.0.1 --port 5617 --strictPort', url: 'http://127.0.0.1:5617/e2e/index.html', reuseExistingServer: false },
});
