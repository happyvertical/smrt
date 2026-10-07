import { expect, test } from '@playwright/test';

test('floating launcher remains usable at 320px with keyboard controls', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/previews/floating-assistant', { waitUntil: 'networkidle' });

  const launcher = page.getByRole('button', { name: 'Open assistant' });
  await launcher.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Collapse assistant' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(launcher).toBeFocused();
  await expect(page.locator('.floating-assistant-panel')).toHaveAttribute(
    'aria-hidden',
    'true',
  );
});

test('reduced motion disables floating panel transitions', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/previews/floating-assistant', { waitUntil: 'networkidle' });
  await expect(page.locator('.floating-assistant-panel')).toHaveCSS(
    'transition-duration',
    '0s',
  );
});
