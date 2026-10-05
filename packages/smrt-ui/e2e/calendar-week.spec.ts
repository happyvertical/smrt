import { expect, test } from '@playwright/test';

test('week navigation retains keyboard focus across a controlled URL-style date update', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto('/e2e/calendar.html');
  await expect(page.getByRole('gridcell')).toHaveCount(7);
  await page.getByRole('button', { name: 'Tuesday, September 29, 2026, 1 item' }).focus();
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-cv-day="2026-10-05"]')).toBeFocused();
  await expect(page.getByLabel('Visible week')).toHaveText('2026-10-05');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Selected day')).toHaveText('2026-10-05');
});

test('phone agenda follows the same seven-day navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/e2e/calendar.html');
  await expect(page.locator('[data-view="agenda"]')).toBeVisible();
  await expect(page.locator('[data-cv-day]')).toHaveCount(7);
  await page.getByRole('button', { name: 'Next week' }).click();
  await expect(page.getByLabel('Visible week')).toHaveText('2026-10-05');
  await expect(page.getByText('Nothing scheduled this week')).toBeVisible();
});
