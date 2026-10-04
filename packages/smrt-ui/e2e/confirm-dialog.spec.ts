import { expect, test } from '@playwright/test';

for (const surface of ['modal', 'drawer']) {
  test(`confirmation sits above ${surface}, traps focus and scopes Escape`, async ({ page }) => {
    await page.goto('/e2e/feedback.html');
    await page.getByRole('button', { name: `Open ${surface}` }).click();
    const parent = page.getByRole('dialog', { name: `Parent ${surface}`, exact: true });
    await parent.getByRole('button', { name: 'Request confirmation' }).click();
    const confirm = page.getByRole('dialog', { name: 'Remove record' });
    await expect(confirm).toBeVisible();
    await expect(confirm.locator('strong')).toHaveText('Floor record');
    await expect(confirm.getByRole('listitem')).toHaveCount(2);
    await expect(confirm.getByRole('button', { name: 'Confirm', exact: true })).toBeFocused();
    expect(await confirm.evaluate((dialog) => dialog.matches(':modal'))).toBe(true);
    expect(await confirm.evaluate((dialog) => {
      const button = dialog.querySelector('button')!;
      const box = button.getBoundingClientRect();
      return dialog.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    })).toBe(true);
    await page.getByRole('button', { name: `Open ${surface}`, exact: true }).evaluate((button: HTMLButtonElement) => button.focus());
    expect(await confirm.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Tab');
    await expect(confirm.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(confirm.getByRole('button', { name: 'Confirm', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(parent).toBeVisible();
    await expect(parent.getByRole('button', { name: 'Request confirmation' })).toBeFocused();
    await expect(page.getByRole('status', { name: 'Cancellation count' })).toHaveText('1');
    await parent.getByRole('button', { name: 'Request confirmation' }).click();
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect(parent).toBeVisible();
  });
}

test('loading dialog retains a reachable Escape and backdrop cancellation', async ({ page }) => {
  await page.goto('/e2e/feedback.html');
  await page.getByRole('button', { name: 'Open modal' }).click();
  const parent = page.getByRole('dialog', { name: 'Parent modal', exact: true });
  await parent.getByRole('button', { name: 'Loading confirmation' }).click();
  const confirm = page.getByRole('dialog', { name: 'Remove record' });
  await expect(confirm).toBeFocused();
  await expect(confirm.getByRole('button', { name: 'Confirm', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(parent).toBeVisible();
  await parent.getByRole('button', { name: 'Request confirmation' }).click();
  await confirm.click({ position: { x: 4, y: 4 } });
  await expect(confirm).toHaveCount(0);
  await expect(parent).toBeVisible();
});
