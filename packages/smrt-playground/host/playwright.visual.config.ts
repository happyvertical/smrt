import { defineConfig } from '@playwright/test';

// Even an ordinary Playwright run can create missing snapshots. Refuse all
// non-Linux runs before Playwright has an opportunity to write a baseline.
if (process.platform !== 'linux') {
  throw new Error(
    'Visual baselines require Linux. See packages/smrt-playground/AGENTS.md for the container/update flow.',
  );
}

const baseURL = process.env.SMRT_VISUAL_BASE_URL || 'http://127.0.0.1:5560';

export default defineConfig({
  testDir: '../e2e',
  testMatch: 'presets.visual.spec.ts',
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  outputDir: '../test-results/visual',
  fullyParallel: true,
  workers: 4,
  retries: 0,
  timeout: 60_000,
  // CI must never silently generate or accept missing baselines.
  updateSnapshots: 'none',
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.0001,
      threshold: 0.1,
    },
  },
  reporter: [
    ['list'],
    ['html', { outputFolder: '../playwright-report/visual', open: 'never' }],
  ],
  use: {
    browserName: 'chromium',
    baseURL,
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'America/Edmonton',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  ...(process.env.SMRT_VISUAL_BASE_URL
    ? {}
    : {
        webServer: {
          command: 'pnpm dev --host 0.0.0.0 --port 5560 --strictPort',
          url: baseURL,
          reuseExistingServer: false,
          timeout: 120_000,
        },
      }),
});
