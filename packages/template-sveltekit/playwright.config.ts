import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from '@playwright/test';

/**
 * Playwright's output root, in a test-owned temporary directory outside the
 * repository. M5 requires every browser profile, database, asset and piece of
 * generated output to live outside the checkout; an in-repo `outputDir` would
 * leave browser output in the working tree for later tooling to pick up, and
 * a `.gitignore` entry is not custody.
 *
 * The name is fixed rather than randomized: Playwright re-loads this config in
 * every worker process, so a `mkdtemp` here would mint one directory per worker
 * while the workers all wrote to the single value the runner serialized to
 * them, leaving empty strays behind. Playwright empties this directory at the
 * start of each run, `globalTeardown` removes it at the end, and specs read it
 * back as `testInfo.project.outputDir` rather than restating the path.
 */
const artifactRoot = join(realpathSync(tmpdir()), 'smrt-m5-artifacts');

/**
 * M5 fresh-browser gate (#2579).
 *
 * There is no `webServer` here on purpose. The application under test is not
 * a dev server this config can start: it is a fresh copy of the generated
 * app, provisioned into a test-owned temporary root and started through its
 * own `scripts/` by the worker fixture in `e2e/fixtures.ts`. Every worker
 * therefore gets a genuinely fresh process, database, and state root.
 */
export default defineConfig({
  testDir: './e2e',
  // Provisioning runs the app's own build; the per-test budget below is for
  // browser work only, and the worker fixture carries its own longer bound.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  // One worker: each worker provisions a whole application, and the gate is
  // about determinism rather than wall-clock.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // `list` writes only test titles and assertion text. No HTML report, no
  // JSON blob of request/response bodies.
  reporter: [['list']],
  // Bound the whole gate independently of the CI job timeout.
  globalTimeout: 30 * 60_000,
  outputDir: artifactRoot,
  // Removes that temporary root when the run ends.
  globalTeardown: './e2e/support/globalTeardown.ts',
  use: {
    // Onboarding carries a single-use bootstrap token in a URL. A trace, a
    // video, or a full-page screenshot would capture it, so all three stay
    // off for every step of this gate — the sanitized summary written by
    // `e2e/support/gate.mjs` is the only artifact worth publishing.
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    headless: true,
    // Nothing here talks to the public internet.
    bypassCSP: false,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
