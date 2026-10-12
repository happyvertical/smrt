import { expect, test } from '@playwright/test';

const settled = () =>
  document
    .getAnimations()
    .every((animation) => animation.playState !== 'running');

test('sidebar collapse transitions the track and ends non-inert and focusable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?left=expanded&right=collapsed');
  const shell = page.locator('.smrt-admin-shell');
  const left = page.locator('.smrt-admin-shell__edge--left');
  await expect(shell).toHaveAttribute('data-motion', '');
  await expect(left).toHaveAttribute('data-state', 'expanded');

  const before = await shell.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      property: style.transitionProperty,
      duration: style.transitionDuration,
      width: el
        .querySelector('.smrt-admin-shell__edge--left')!
        .getBoundingClientRect().width,
    };
  });
  expect(before.property).toContain('grid-template-columns');
  expect(before.duration).not.toBe('0s');

  await page.locator('.smrt-admin-shell__edge-toggle--left').first().click();
  await expect(left).toHaveAttribute('data-state', 'collapsed');
  await page.waitForFunction(settled);

  expect(await left.evaluate((el) => el.hasAttribute('inert'))).toBe(false);
  const after = await left.evaluate((el) => el.getBoundingClientRect().width);
  expect(after).toBeLessThan(before.width);
  const focusable = left.locator('a[href], button:not([disabled])').first();
  await focusable.focus();
  await expect(focusable).toBeFocused();
});

test('the resize drag is immediate (no track transition while resizing)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?left=expanded&right=collapsed');
  const shell = page.locator('.smrt-admin-shell');
  await expect(shell).toHaveAttribute('data-motion', '');
  const duration = await shell.evaluate((el) => {
    el.setAttribute('data-resizing', 'left');
    return getComputedStyle(el).transitionDuration;
  });
  expect(duration).toBe('0s');
});

test('reduced motion disables the track transition', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?left=expanded&right=collapsed');
  const shell = page.locator('.smrt-admin-shell');
  const duration = await shell.evaluate(
    (el) => getComputedStyle(el).transitionDuration,
  );
  expect(duration).toBe('0s');
  await page.locator('.smrt-admin-shell__edge-toggle--left').first().click();
  await expect(page.locator('.smrt-admin-shell__edge--left')).toHaveAttribute(
    'data-state',
    'collapsed',
  );
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
});
