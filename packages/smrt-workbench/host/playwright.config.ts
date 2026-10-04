import { defineConfig } from '@playwright/test';

const port = Number(process.env.SMRT_WORKBENCH_TEST_PORT || 5570);
const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  outputDir: process.env.CI_TEST_TMPDIR ? `${process.env.CI_TEST_TMPDIR}/workbench-results` : './test-results',
  webServer: {
    command:
      `pnpm build && pnpm preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
  use: {
    ...(chromiumExecutablePath ? { launchOptions: { executablePath: chromiumExecutablePath } } : {}),
    baseURL: `http://127.0.0.1:${port}`,
  },
});
