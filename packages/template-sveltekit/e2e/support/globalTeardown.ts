/**
 * Remove the temporary Playwright output root the config created.
 *
 * M5 keeps every piece of generated output outside the checkout, in a
 * test-owned temporary directory. Playwright creates that directory and never
 * removes it, so without this the gate would leave every run's browser output
 * sitting there — the same litter the reference-app harness avoids in its own
 * `stop()`.
 *
 * Playwright writes its own `.last-run.json` into the root *after* teardown
 * returns, so the directory itself reappears with that one status file in it.
 * That file carries case ids and outcomes only, it is outside the repository,
 * and the next run overwrites it; what this removes is everything the tests
 * themselves put there.
 */

import { rmSync } from 'node:fs';

import type { FullConfig } from '@playwright/test';

export default function globalTeardown(config: FullConfig): void {
  const root = config.projects[0]?.outputDir;
  // Only ever a directory this config made: guard on the name it chose so a
  // misconfiguration can never turn this into a broader delete.
  if (!root || !/[\\/]smrt-m5-artifacts$/.test(root)) return;
  rmSync(root, { recursive: true, force: true });
}
