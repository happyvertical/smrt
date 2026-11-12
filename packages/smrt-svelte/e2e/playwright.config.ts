import { defineConfig } from '@playwright/test';

// Allow concurrent worktrees to select their own isolated browser-test port.
const port = Number(process.env.SMRT_E2E_PORT ?? 47851);

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  workers: 1,
  retries: 0,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    },
    hasTouch: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm exec vite build --config e2e/vite.config.ts && pnpm exec vite preview --config e2e/vite.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: new URL('..', import.meta.url).pathname,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
});
