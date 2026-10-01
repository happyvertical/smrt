import { expect, test } from '@playwright/test';

for (const width of [320, 390, 1280]) {
  test(`legacy dock live region stays within a ${width}px viewport`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/tools-dock.html');
    const status = page.getByRole('status');
    await expect(status).toHaveAttribute('aria-live', 'polite');
    await expect(status).not.toHaveAttribute('aria-hidden', 'true');
    const bounds = await status.boundingBox();
    if (!bounds) throw new Error('Missing live region bounds');
    expect(bounds.width).toBe(1);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);

    const activate = page.getByRole('button', {
      name: 'Notes tool',
      exact: true,
    });
    await activate.click();
    await expect(status).toHaveText('Notes tool opened');
    await expect(
      page.getByRole('dialog', { name: 'Notes tool panel' }),
    ).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBe(width);
    await page.keyboard.press('Escape');
    await expect(status).toBeEmpty();
    await expect(activate).toBeFocused();
  });
}
