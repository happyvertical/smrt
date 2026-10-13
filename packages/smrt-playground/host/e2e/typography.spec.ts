import { expect, test } from '@playwright/test';

const PRESETS = ['material', 'glass', 'studio', 'smrt', 'happyvertical'];

/** Optional directory for per-preset screenshots (set TYPOGRAPHY_SHOTS_DIR). */
const shotsDir = process.env.TYPOGRAPHY_SHOTS_DIR?.trim();

test('headings render the preset display role and body is not a serif fallback', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();

  for (const preset of PRESETS) {
    await page
      .locator('.smrt-theme-switcher__select')
      .first()
      .selectOption(preset);
    await expect(page.locator('html')).toHaveAttribute('data-theme', preset);

    const computed = await page.evaluate(() => {
      const family = (el: Element | null) =>
        el ? getComputedStyle(el).fontFamily : null;
      const token = (name: string) =>
        getComputedStyle(document.documentElement)
          .getPropertyValue(name)
          .trim();
      return {
        body: family(document.body),
        h1: family(document.querySelector('h1')),
        h2: family(document.querySelector('main h2')),
        displayFamily: token('--smrt-typography-display-small-font-family'),
        headlineFamily: token('--smrt-typography-headline-large-font-family'),
        bodyFamily: token('--smrt-font-family'),
      };
    });

    expect(computed.body, `${preset} body`).not.toMatch(/^"?Times/i);
    expect(norm(computed.body), `${preset} body`).toBe(
      norm(computed.bodyFamily),
    );
    expect(computed.h1, `${preset} h1`).toBeTruthy();
    expect(norm(computed.h1)).toBe(
      norm(resolved(computed.displayFamily, computed)),
    );
    expect(norm(computed.h2)).toBe(
      norm(resolved(computed.headlineFamily, computed)),
    );

    if (shotsDir) {
      await page.screenshot({
        path: `${shotsDir}/${preset}.png`,
        clip: { x: 0, y: 0, width: 1280, height: 360 },
      });
    }
  }
});

/** `var(--smrt-font-family)` roles resolve to the body family. */
function resolved(role: string, computed: { bodyFamily: string }) {
  return role === 'var(--smrt-font-family)' ? computed.bodyFamily : role;
}

/** Leading family of a font stack, quotes and spacing removed. */
function norm(value: string | null) {
  // Chrome also rewrites some keywords (BlinkMacSystemFont -> system-ui), so
  // compare the leading family, which is the one that paints.
  return (value ?? '').replace(/["'\s]/g, '').split(',')[0];
}
