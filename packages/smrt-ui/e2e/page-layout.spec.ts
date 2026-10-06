import { expect, test } from '@playwright/test';

for (const width of [320, 390, 768]) {
  test(`nested page content contains wide tables and tabs at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1024 });
    await page.goto('/e2e/density-responsive.html?surface=layout');
    await expect(page.getByRole('heading', { name: 'Construction project' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    for (const selector of ['.tabs-links-row', '.data-table-container']) {
      const scroll = page.locator(selector);
      expect(await scroll.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
      await scroll.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
      expect(await scroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    }
    await expect(page.getByRole('link', { name: 'Project section 11', exact: true })).toBeInViewport();
    await page.getByRole('link', { name: 'Project section 11', exact: true }).click();
    await expect(page).toHaveURL(/#section11$/);
    await expect(page.getByRole('columnheader', { name: 'Column 6' })).toBeInViewport();
  });
}
