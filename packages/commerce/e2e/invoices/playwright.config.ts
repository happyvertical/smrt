import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  testDir: '.', testMatch: '*.spec.ts', workers: 1,
  outputDir: process.env.CI_TEST_TMPDIR ? `${process.env.CI_TEST_TMPDIR}/playwright-results` : '../../test-results/invoices',
  use: { baseURL: 'http://127.0.0.1:5586', viewport: { width: 390, height: 844 }, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } } : {}) },
  webServer: {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), command: 'pnpm exec vite --config e2e/invoices/vite.config.ts --host 127.0.0.1 --port 5586 --strictPort', url: 'http://127.0.0.1:5586/e2e/invoices/index.html', reuseExistingServer: false },
});
