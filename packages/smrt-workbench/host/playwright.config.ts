import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  webServer: {
    command:
      'pnpm build && pnpm preview --host 127.0.0.1 --port 5570 --strictPort',
    url: 'http://127.0.0.1:5570',
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: 'http://127.0.0.1:5570',
  },
});
