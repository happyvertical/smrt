import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: 'files.scenario.ts', workers: 1, retries: 0, use: { baseURL: 'http://127.0.0.1:47867', trace: 'retain-on-failure' }, webServer: { command: 'node e2e/files-server.mjs', cwd: new URL('..', import.meta.url).pathname, url: 'http://127.0.0.1:47867', reuseExistingServer: false } });
