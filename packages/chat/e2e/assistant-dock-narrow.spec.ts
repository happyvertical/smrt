/**
 * AssistantDock in narrow containers (#3000), measured in a real browser.
 * jsdom has no layout and ignores `@container`, so this is the regression
 * for the width behavior itself.
 */
import { expect, type Page, test } from '@playwright/test';

const box = (width: number) => `.dock-box[data-width="${width}"]`;

async function mainWidth(page: Page, width: number) {
  const rect = await page
    .locator(`${box(width)} .assistant-dock-main`)
    .boundingBox();
  return rect?.width ?? 0;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/previews/assistant-dock-narrow', {
    waitUntil: 'networkidle',
  });
  await expect(page.locator('.assistant-dock-main')).toHaveCount(3);
});

for (const width of [250, 285]) {
  test(`${width}px: the conversation keeps the width and the list collapses`, async ({
    page,
  }) => {
    const toggle = page.locator(`${box(width)} .assistant-dock-threads-toggle`);
    const threads = page.locator(`${box(width)} .assistant-dock-threads`);
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(threads).toBeHidden();
    expect(await mainWidth(page, width)).toBeGreaterThanOrEqual(200);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(threads).toBeVisible();
    expect(await mainWidth(page, width)).toBeGreaterThanOrEqual(200);

    await page
      .locator(`${box(width)} .assistant-thread-list-new`)
      .press('Enter');
    await expect(threads).toBeHidden();
    await expect(toggle).toBeFocused();
  });
}

test('800px: the thread list stays beside the conversation', async ({
  page,
}) => {
  const threads = page.locator(`${box(800)} .assistant-dock-threads`);
  await expect(
    page.locator(`${box(800)} .assistant-dock-threads-toggle`),
  ).toBeHidden();
  await expect(threads).toBeVisible();
  const list = await threads.boundingBox();
  const main = await page
    .locator(`${box(800)} .assistant-dock-main`)
    .boundingBox();
  expect(list && main && list.x + list.width <= main.x + 1).toBe(true);
  expect(main && list && Math.abs(main.y - list.y) < 1).toBe(true);
});

test('the composer textarea uses --smrt-font-family', async ({ page }) => {
  for (const width of [250, 800]) {
    const font = await page
      .locator(`${box(width)} textarea`)
      .evaluate((el) => getComputedStyle(el).fontFamily);
    expect(font).toContain('Georgia');
  }
});
