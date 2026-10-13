import { expect, test, type Page } from '@playwright/test';

const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
});
test.afterEach(({ page }) => {
  expect(browserErrors.get(page)).toEqual([]);
});

const TRANSPARENT = 'rgba(0, 0, 0, 0)';

async function computed(page: Page, selector: string, props: string[]) {
  return page.locator(selector).first().evaluate((element, names) => {
    const style = getComputedStyle(element);
    return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name)]));
  }, props);
}

test('unstyled.css reverts themed look and keeps layout in Chromium', async ({
  page,
}) => {
  await page.goto('/e2e/styleless.html');
  const toggle = page.getByRole('checkbox', { name: 'Apply unstyled.css' });
  const card = '[data-smrt-component="Card"]';
  const badge = '[data-smrt-component="Badge"]';
  const button = 'button[data-smrt-component="Button"]';

  const themed = {
    card: await computed(page, card, ['background-color', 'padding-top']),
    badge: await computed(page, badge, ['background-color', 'display']),
    button: await computed(page, button, ['background-color', 'border-top-width']),
  };
  // Baseline: the smrt theme paints the look, so these are not the UA defaults.
  expect(themed.card['background-color']).not.toBe(TRANSPARENT);
  expect(themed.badge['background-color']).not.toBe(TRANSPARENT);
  expect(themed.button['background-color']).not.toBe(TRANSPARENT);

  await toggle.check();
  await expect(page.locator('style[data-smrt-styleless]')).toHaveCount(1);

  // Look is reverted: colour and background fall back to the UA defaults. Card
  // and Button declare `transition: all`, so the change animates; poll until
  // the transition settles instead of reading mid-flight.
  await expect
    .poll(async () => (await computed(page, card, ['background-color']))['background-color'])
    .toBe(TRANSPARENT);
  await expect
    .poll(async () => (await computed(page, button, ['background-color']))['background-color'])
    .toBe(TRANSPARENT);
  const styleless = {
    card: await computed(page, card, ['background-color', 'padding-top']),
    badge: await computed(page, badge, ['background-color', 'display']),
    button: await computed(page, button, ['background-color', 'border-top-width']),
  };
  expect(styleless.badge['background-color']).toBe(TRANSPARENT);
  // The reset strips the UA button border that a themed button would not show.
  expect(styleless.button['border-top-width']).toBe('0px');
  // Layout is kept: display and padding match the themed render. The badge is
  // a flex item, so its display is blockified to `flex` in both renders.
  expect(styleless.badge.display).toBe(themed.badge.display);
  expect(styleless.card['padding-top']).toBe(themed.card['padding-top']);
  // Text inherits the page typography instead of the browser's serif default.
  const fonts = await page.evaluate(() => ({
    body: getComputedStyle(document.body).fontFamily,
    badge: getComputedStyle(
      document.querySelector('[data-smrt-component="Badge"]') as Element,
    ).fontFamily,
  }));
  expect(fonts.badge).toBe(fonts.body);

  // Unlayered consumer CSS still wins over every smrt layer.
  await page.addStyleTag({
    content: '[data-smrt-component="Card"] { background-color: rgb(1, 2, 3); }',
  });
  await expect
    .poll(async () => (await computed(page, card, ['background-color']))['background-color'])
    .toBe('rgb(1, 2, 3)');

  // Toggling off removes the stylesheet and restores the themed look.
  await toggle.uncheck();
  await expect(page.locator('style[data-smrt-styleless]')).toHaveCount(0);
  await page.evaluate(() =>
    document.querySelectorAll('style:not([data-smrt-styleless])').forEach((node) => {
      if (node.textContent?.includes('rgb(1, 2, 3)')) node.remove();
    }),
  );
  await expect
    .poll(async () => (await computed(page, badge, ['background-color']))['background-color'])
    .toBe(themed.badge['background-color']);
});
