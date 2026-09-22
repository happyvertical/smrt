import { defineConfig } from '@playwright/test';

const port = 4174;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL, headless: true },
  webServer: {
    command: `pnpm exec vite dev --host 127.0.0.1 --port ${port}`,
    cwd: new URL('.', import.meta.url).pathname,
    url: `${baseURL}/previews/assistant-dock-narrow`,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
});
