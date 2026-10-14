import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/** Optional directory for a readable copy of the screenshot (PR evidence). */
const shotsDir = process.env.FORCED_COLORS_SHOTS_DIR?.trim();

test('Base Controls render with system colours under forced-colors: active', async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: 'active', colorScheme: 'light' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('playground-preview-title')).toHaveText(
    'Base Controls',
  );
  const stage = page.getByTestId('playground-preview-stage');
  await expect(stage).toBeVisible();

  const probe = (keyword: string) =>
    page.evaluate((name) => {
      const el = document.createElement('div');
      el.style.color = name;
      document.body.append(el);
      const value = getComputedStyle(el).color;
      el.remove();
      return value;
    }, keyword);
  const canvasText = await probe('CanvasText');

  const input = stage.locator('input[name="name"]');
  const edge = await input.evaluate((el) => {
    const s = getComputedStyle(el);
    return { border: s.borderTopColor, shadow: s.boxShadow };
  });
  expect(edge.border).toBe(canvasText);
  expect(edge.shadow === 'none' || !/rgba?\((?!0, 0, 0, 0\))/.test(edge.shadow)).toBe(
    true,
  );

  await input.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(input).toBeFocused();
  const ring = await input.evaluate((el) => {
    const s = getComputedStyle(el);
    return { width: Number.parseFloat(s.outlineWidth), style: s.outlineStyle };
  });
  expect(ring.style).toBe('solid');
  expect(ring.width).toBeGreaterThanOrEqual(2);

  await page.waitForTimeout(500);
  if (shotsDir) {
    mkdirSync(shotsDir, { recursive: true });
    await page.screenshot({
      path: join(shotsDir, 'base-controls-forced-colors-light.png'),
    });
  }
});
