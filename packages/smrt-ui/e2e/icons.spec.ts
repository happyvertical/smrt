import { expect, test } from '@playwright/test';

test('common glyphs paint bounded SVG geometry and application registration updates mounted icons', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/e2e/icons.html');
  await expect(page.getByRole('button', { name: 'Register shop icons' })).toBeVisible();
  expect(errors).toEqual([]);
  for (const name of ['alert', 'warning', 'info', 'home', 'user', 'settings', 'trash', 'edit', 'calendar', 'clock', 'camera', 'upload', 'download']) {
    const path = page.getByRole('img', { name, exact: true }).locator('path');
    const box = await path.evaluate((node: SVGGraphicsElement) => {
      const rect = node.getBBox();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(24);
    expect(box.y + box.height).toBeLessThanOrEqual(24);
  }
  const custom = page.getByRole('img', { name: 'Shop machine' }).locator('path');
  await expect(custom).not.toHaveAttribute('d');
  await page.getByRole('button', { name: 'Register shop icons' }).click();
  await expect(custom).toHaveAttribute('d', 'M4 4h16v16H4z');
  expect(await custom.evaluate((node: SVGGraphicsElement) => node.getBBox().width)).toBe(16);
  await page.getByRole('button', { name: 'Remove shop icons' }).click();
  await expect(custom).not.toHaveAttribute('d');
});
