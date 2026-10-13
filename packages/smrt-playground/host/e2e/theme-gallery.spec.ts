import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const PRESETS = ['material', 'glass', 'studio', 'smrt', 'happyvertical'];
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 375, height: 812 };

/**
 * Baselines are Chromium-on-macOS (`*-darwin.png`, Playwright's default
 * `{platform}` snapshot suffix). Text rasterization differs on Linux, so CI
 * only asserts the page renders there; pixel comparison runs on darwin.
 * Update: `pnpm --filter smrt-playground-host test:e2e:update-snapshots`.
 */
const compareBaselines = process.platform === 'darwin';

/** Optional directory for readable `<preset>-<scheme>-<width>.png` copies. */
const shotsDir = process.env.THEME_GALLERY_SHOTS_DIR?.trim();

const cases = [
  ...PRESETS.flatMap((preset) =>
    (['light', 'dark'] as const).map((scheme) => ({
      preset,
      scheme,
      viewport: DESKTOP,
    })),
  ),
  ...PRESETS.map((preset) => ({
    preset,
    scheme: 'dark' as const,
    viewport: PHONE,
  })),
];

for (const { preset, scheme, viewport } of cases) {
  const label = `${preset}-${scheme}-${viewport.width}`;

  test(`theme gallery ${label}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(`/theme-gallery?theme=${preset}&scheme=${scheme}`);
    await expect(page.locator('[data-testid="theme-gallery"][data-ready="true"]')).toBeVisible();
    await expect(page.locator('[data-theme]').first()).toHaveAttribute(
      'data-theme',
      preset,
    );
    await expect(
      page.locator(`[data-color-scheme="${scheme}"]`).first(),
    ).toBeAttached();
    await page.evaluate(() => document.fonts.ready);
    // The shell scrolls inside its own main region, so a full-page capture only
    // sees one viewport. Grow the viewport to fit the tallest scroller (width
    // stays as specified) so the screenshot shows the whole composition.
    const extra = await page.evaluate(() => {
      let most = 0;
      for (const el of document.querySelectorAll('*')) {
        const overflow = getComputedStyle(el).overflowY;
        if (overflow === 'auto' || overflow === 'scroll') {
          most = Math.max(most, el.scrollHeight - el.clientHeight);
        }
      }
      return most;
    });
    if (extra > 0) {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height + extra,
      });
    }
    // Let the scheme crossfade and the menu/toast enter animations settle.
    await page.waitForTimeout(500);

    if (shotsDir) {
      mkdirSync(shotsDir, { recursive: true });
      await page.screenshot({
        path: join(shotsDir, `${label}.png`),
        fullPage: true,
        animations: 'disabled',
        caret: 'hide',
      });
    }

    if (!compareBaselines) {
      await expect(page.locator('h1').first()).toBeVisible();
      return;
    }

    await expect(page).toHaveScreenshot(`${label}.png`, {
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.01,
    });
  });
}
