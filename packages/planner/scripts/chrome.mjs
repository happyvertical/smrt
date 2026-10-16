import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

/**
 * The Chrome the browser suites drive: `CHROME_PATH`, an installed Chrome or
 * Chromium, then the Chromium `playwright install chromium` provides (what the
 * monorepo's CI installs). Throws naming the suite when none exists.
 */
export function chromeExecutable(suite) {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  try {
    candidates.push(chromium.executablePath());
  } catch {
    // No Playwright-managed browser registered.
  }
  const found = candidates.find((path) => path && existsSync(path));
  if (!found) throw new Error(`Chrome/Chromium is required for ${suite}`);
  return found;
}
