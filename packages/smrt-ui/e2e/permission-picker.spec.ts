import { expect, test } from '@playwright/test';

for (const width of [320, 390]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`permission picker fits ${width}px in ${scheme} theme with keyboard and touch defaults`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/e2e/density-responsive.html?surface=permissions&scheme=${scheme}`);
      const picker = page.locator('.permission-picker');
      await expect(picker).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const search = page.getByRole('searchbox', { name: 'Search permissions' });
      await search.focus();
      await page.keyboard.press('Tab');
      const summary = page.getByText('Construction', { exact: true }).locator('..');
      await expect(summary).toBeFocused();
      expect(await summary.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Tab');
      await expect(page.getByRole('checkbox', { name: 'Manage specialist construction records' })).toBeFocused();
      const slug = page.locator('code').filter({ hasText: 'extraordinarily_long_unbroken' });
      await expect(slug).toBeVisible();
      expect(await slug.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      const hitSize = await page.locator('.choice .checkbox').first().evaluate((element) => getComputedStyle(element, '::before').blockSize);
      expect(Number.parseFloat(hitSize)).toBeGreaterThanOrEqual(44);
      const surface = await page.locator('main').evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        color: getComputedStyle(element).color,
      }));
      expect(surface.background).not.toBe('rgba(0, 0, 0, 0)');
      expect(surface.color).not.toBe(surface.background);
    });
  }
}
