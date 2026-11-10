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

  // The entire theme layer, including transitions, is reverted immediately.
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

const PRIMITIVES = ['Button', 'Badge', 'Chip', 'Card', 'Alert', 'Input', 'Select', 'Checkbox', 'Switch', 'Tabs'];

for (const preset of ['material', 'glass', 'studio', 'smrt', 'happyvertical']) {
for (const scheme of ['light', 'dark']) {
  test(`exact styleless mode ${preset}/${scheme} preserves primitive structure`, async ({ page }) => {
    await page.goto('/e2e/styleless.html');
    await page.addStyleTag({ content: '* , *::before, *::after { transition: none; animation: none; }' });
    await page.evaluate(({ preset, scheme }) => {
      document.documentElement.dataset.theme = preset;
      document.documentElement.dataset.colorScheme = scheme;
    }, { preset, scheme });
    const root = (name: string) => `[data-smrt-component="${name}"]`;
    const geometry = ['display', 'position', 'padding-top', 'padding-right', 'gap', 'min-height'];
    const before = new Map<string, Record<string, string>>();
    for (const name of PRIMITIVES) before.set(name, await computed(page, root(name), geometry));
    const cardBody = `${root('Card')} [data-smrt-part="body"]`;
    const bodyPadding = await computed(page, cardBody, ['padding-top']);
    await page.getByRole('checkbox', { name: 'Apply unstyled.css' }).check();
    for (const name of PRIMITIVES) {
      await expect.poll(() => computed(page, root(name), geometry)).toEqual(before.get(name));
      await expect.poll(async () => (await computed(page, root(name), ['background-color']))['background-color']).toBe(TRANSPARENT);
    }
    expect(await computed(page, cardBody, ['padding-top'])).toEqual(bodyPadding);
    for (const name of PRIMITIVES) {
      expect(await computed(page, root(name), ['border-top-width', 'border-radius', 'box-shadow', 'transition-duration'])).toEqual({
        'border-top-width': '0px', 'border-radius': '0px', 'box-shadow': 'none', 'transition-duration': '0s',
      });
      const typography = await page.locator(root(name)).first().evaluate((element) => {
        const style = getComputedStyle(element), body = getComputedStyle(document.body);
        return [style.color === body.color, style.fontFamily === body.fontFamily, style.fontSize === body.fontSize];
      });
      expect(typography).toEqual([true, true, true]);
    }
    for (const name of ['Checkbox', 'Switch']) {
      expect(await computed(page, `${root(name)} [data-smrt-part="input"]`, ['opacity', 'position'])).toEqual({ opacity: '0', position: 'absolute' });
      await page.locator(root(name)).click();
      await expect(page.locator(`${root(name)} input`)).toBeChecked();
    }
    const track = `${root('Switch')} [data-smrt-part="thumb"]`;
    expect((await computed(page, track, ['transform'])).transform).not.toBe('none');
    await expect(page.locator(`${root('Checkbox')} [data-smrt-part="indicator"]`)).toBeVisible();
    await page.getByRole('tab', { name: 'Activity' }).click();
    await expect(page.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true');
    expect(Number.parseFloat((await computed(page, `${root('Tabs')} [aria-selected="true"] [data-smrt-part="indicator"]`, ['width'])).width)).toBeGreaterThan(0);
    expect((await computed(page, `${root('Tabs')} [aria-selected="false"] [data-smrt-part="indicator"]`, ['width'])).width).toBe('0px');
    await page.addStyleTag({ content: `${cardBody} { padding: 13px; background: rgb(1, 2, 3); }` });
    expect(await computed(page, cardBody, ['padding-top', 'background-color'])).toEqual({ 'padding-top': '13px', 'background-color': 'rgb(1, 2, 3)' });
  });
}
}

test('generic consumer classes cannot reach component-owned elements; parts can', async ({ page }) => {
  await page.goto('/e2e/styleless.html');
  await page.addStyleTag({ content: '.button, .badge, .card, .input, .select, .checkbox, .switch, .content, .label, .header, .actions, .icon, .active, .primary, .md { display: none; }' });
  for (const name of PRIMITIVES) await expect(page.locator(`[data-smrt-component="${name}"]`).first()).toBeVisible();
  for (const [name, part] of [['Button', 'label'], ['Card', 'body'], ['Chip', 'body'], ['Alert', 'body'], ['Checkbox', 'label'], ['Switch', 'track'], ['Tabs', 'tab']]) {
    await expect(page.locator(`[data-smrt-component="${name}"] [data-smrt-part="${part}"]`).first()).toBeVisible();
  }
});

test('a sorted component nested in a Card slot keeps its layout (#3881)', async ({ page }) => {
  await page.goto('/e2e/styleless.html');
  const nested = '[data-smrt-component="Card"] [data-smrt-part="footer"] [data-smrt-component="Button"]';
  const properties = ['display', 'gap', 'padding-top', 'padding-right', 'position'];
  const before = await computed(page, nested, properties);
  expect(before.display).toBe('inline-flex');
  expect(Number.parseFloat(before['padding-right'])).toBeGreaterThan(0);
  await page.getByRole('checkbox', { name: 'Apply unstyled.css' }).check();
  expect(await computed(page, nested, properties)).toEqual(before);
  expect(await computed(page, nested, ['background-color', 'box-shadow', 'transition-duration'])).toEqual({
    'background-color': TRANSPARENT, 'box-shadow': 'none', 'transition-duration': '0s',
  });
});

 test('pseudo-element paint is removed while transparent hit areas survive', async ({ page }) => {
  await page.goto('/e2e/styleless.html');
  const selector = '[data-smrt-component="Checkbox"]';
  await page.addStyleTag({ content: `@layer smrt.theme { ${selector}::before, ${selector}::after { background: red; border-radius: 10px; box-shadow: 0 0 2px red; transition: all 1s; } }` });
  const read = () => page.locator(selector).evaluate((element) => {
    const style = getComputedStyle(element, '::before');
    return Object.fromEntries(['content', 'position', 'width', 'height'].map((name) => [name, style.getPropertyValue(name)]));
  });
  const before = await read();
  expect(before.content).toBe('""');
  expect(before.position).toBe('absolute');
  expect(Number.parseFloat(before.height)).toBeGreaterThanOrEqual(44);
  await page.getByRole('checkbox', { name: 'Apply unstyled.css' }).check();
  expect(await read()).toEqual(before);
  for (const pseudo of ['::before', '::after']) {
    expect(await page.locator(selector).evaluate((element, pseudo) => {
      const style = getComputedStyle(element, pseudo);
      return [style.backgroundColor, style.borderRadius, style.boxShadow, style.transitionDuration];
    }, pseudo)).toEqual([TRANSPARENT, '0px', 'none', '0s']);
  }
});
