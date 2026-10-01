import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/e2e/toast.html');
});

test('follows modal opening order, nested confirmation and reopening, then restores host', async ({ page }) => {
  const viewport = page.getByRole('region', { name: 'Notifications' });
  expect(await viewport.evaluate((node) => node.parentElement?.id)).toBe('normal-host');
  await page.getByRole('button', { name: 'Open first modal' }).click();
  const first = page.getByRole('dialog', { name: 'First modal', exact: true });
  await first.getByRole('button', { name: 'Notify first' }).click();
  await expect(first.getByRole('region', { name: 'Notifications' })).toBeVisible();
  await expect(viewport.getByRole('status')).toContainText('Approval recorded');
  const snapshot = await page.locator('body').ariaSnapshot();
  expect(snapshot).toContain('Notifications');
  expect(snapshot).toContain('Approval recorded');
  await first.getByRole('button', { name: 'Open second modal' }).click();
  const second = page.getByRole('dialog', { name: 'Second modal', exact: true });
  await expect(second.getByRole('region', { name: 'Notifications' })).toBeVisible();
  await second.getByRole('button', { name: 'Open confirmation' }).click();
  const confirm = page.getByRole('dialog', { name: 'Top confirmation' });
  await expect(confirm.getByRole('region', { name: 'Notifications' })).toBeVisible();
  await viewport.getByRole('button', { name: 'Undo approval' }).click();
  await expect(page.locator('output')).toHaveText('1');
  await expect(viewport.getByRole('status')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(second.getByRole('region', { name: 'Notifications' })).toBeAttached();
  await expect(second).toBeVisible();
  await second.getByRole('button', { name: 'Notify second' }).click();
  await viewport.getByRole('button', { name: 'Dismiss' }).focus();
  await expect(viewport.getByRole('button', { name: 'Dismiss' })).toBeFocused();
  await viewport.getByRole('button', { name: 'Dismiss' }).click();
  await second.getByRole('button', { name: 'Close modal' }).click();
  await expect(first.getByRole('region', { name: 'Notifications' })).toBeAttached();
  await first.getByRole('button', { name: 'Open second modal' }).click();
  await expect(second.getByRole('region', { name: 'Notifications' })).toBeAttached();
  await second.getByRole('button', { name: 'Close modal' }).click();
  await first.getByRole('button', { name: 'Notify first' }).click();
  await first.getByRole('button', { name: 'Open native dialog' }).click();
  const native = page.getByRole('dialog', { name: 'Native modal' });
  await expect(native.getByRole('region', { name: 'Notifications' })).toBeVisible();
  await native.getByRole('button', { name: 'Dismiss' }).click();
  await native.getByRole('button', { name: 'Close native' }).click();
  await first.getByRole('button', { name: 'Close modal' }).click();
  expect(await viewport.evaluate((node) => node.parentElement?.id)).toBe('normal-host');
  await page.getByRole('button', { name: 'Unmount viewport' }).click();
  await expect(page.locator('.viewport')).toHaveCount(0);
});

test('hover and keyboard focus independently pause remaining auto-dismiss time', async ({ page }) => {
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.getByRole('button', { name: 'Timed notification', exact: true }).click();
  const toast = page.getByRole('group', { name: 'Notification' });
  await page.clock.runFor(300);
  await toast.hover();
  await toast.getByRole('button', { name: 'Dismiss' }).focus();
  await page.clock.runFor(5000);
  await expect(toast).toBeVisible();
  await page.mouse.move(0, 0);
  await page.clock.runFor(5000);
  await expect(toast).toBeVisible();
  await page.getByRole('button', { name: 'Toggle anchor' }).focus();
  await page.clock.runFor(699);
  await expect(toast).toBeVisible();
  await page.clock.runFor(1);
  await expect(toast).toHaveCount(0);
});

test('anchors and centers within a content region, updates on resize, and supports window inset', async ({ page }) => {
  await page.getByRole('button', { name: 'Notify outside', exact: true }).click();
  const viewport = page.getByRole('region', { name: 'Notifications' });
  const windowBox = await viewport.boundingBox();
  expect(windowBox).not.toBeNull();
  expect(windowBox!.x + windowBox!.width).toBeCloseTo(1280 - 12, 0);
  await page.getByRole('button', { name: 'Toggle anchor' }).click();
  const region = page.locator('.content-region');
  await expect.poll(async () => {
    const anchorBox = (await region.boundingBox())!;
    const toastBox = (await viewport.boundingBox())!;
    return Math.abs(toastBox.x + toastBox.width / 2 - (anchorBox.x + anchorBox.width / 2));
  }).toBeLessThan(1);
  let anchorBox = (await region.boundingBox())!;
  let toastBox = (await viewport.boundingBox())!;
  expect(toastBox.y + toastBox.height).toBeCloseTo(anchorBox.y + anchorBox.height - 12, 0);
  await region.evaluate((node: HTMLElement) => { node.style.width = '700px'; });
  await expect.poll(async () => {
    anchorBox = (await region.boundingBox())!;
    toastBox = (await viewport.boundingBox())!;
    return Math.abs(toastBox.x + toastBox.width / 2 - (anchorBox.x + anchorBox.width / 2));
  }).toBeLessThan(1);
});
