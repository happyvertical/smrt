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

/** Resolve a system colour keyword the way the browser paints it. */
async function systemColor(page: Page, keyword: string) {
  return page.evaluate((name) => {
    const probe = document.createElement('div');
    probe.style.color = name;
    document.body.append(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  }, keyword);
}

function style(page: Page, selector: string, prop: string, pseudo?: string) {
  return page
    .locator(selector)
    .first()
    .evaluate(
      (element, args) =>
        getComputedStyle(element, args.pseudo ?? null).getPropertyValue(
          args.prop,
        ),
      { prop, pseudo },
    );
}

/** True when a computed box-shadow paints nothing. */
function isInvisibleShadow(value: string) {
  return value === 'none' || !/rgba?\((?!0, 0, 0, 0\))/.test(value);
}

function isNoBlur(value: string) {
  return (
    value === 'none' || (/blur\(0px\)/.test(value) && !/blur\([1-9]/.test(value))
  );
}

const CARD = '[data-smrt-component="Card"]';
const TABS = '[data-smrt-component="Tabs"]';

for (const variant of ['static', 'inline'] as const) {
  test.describe(`forced-colors: active (${variant} tokens)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ forcedColors: 'active' });
      await page.goto(
        `/e2e/forced-colors.html${variant === 'inline' ? '?inline' : ''}`,
      );
      await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
    });

    test('ThemeProvider stamps the contract and tokens resolve to system colours', async ({
      page,
    }) => {
      await expect(page.locator('html')).toHaveAttribute(
        'data-contrast',
        'forced',
      );
      await expect(page.locator('html')).toHaveAttribute(
        'data-forced-colors',
        '',
      );
      const canvasText = await systemColor(page, 'CanvasText');
      const highlight = await systemColor(page, 'Highlight');
      const tokens = await page.evaluate(() => {
        const root = getComputedStyle(
          document.querySelector('.smrt-theme-root') as Element,
        );
        const read = (name: string) => root.getPropertyValue(name).trim();
        return {
          hairline: read('--smrt-hairline-color'),
          strong: read('--smrt-hairline-strong-color'),
          ring: read('--smrt-focus-ring-color'),
          width: read('--smrt-focus-ring-width'),
          blur: read('--smrt-glass-blur'),
          highlight: read('--smrt-inset-highlight'),
          elevation: read('--smrt-elevation-3'),
        };
      });
      expect(tokens.hairline).toBe('CanvasText');
      expect(tokens.strong).toBe('CanvasText');
      expect(tokens.ring).toBe('Highlight');
      expect(Number.parseFloat(tokens.width)).toBeGreaterThanOrEqual(2);
      expect(tokens.blur).toBe('0px');
      expect(isInvisibleShadow(tokens.highlight)).toBe(true);
      expect(isInvisibleShadow(tokens.elevation)).toBe(true);
      expect(await style(page, CARD, 'border-top-color')).toBe(canvasText);
      expect(highlight).not.toBe('');
    });

    test('panels and controls draw CanvasText edges with no shadow', async ({
      page,
    }) => {
      const canvasText = await systemColor(page, 'CanvasText');
      for (const selector of [
        CARD,
        '[data-smrt-component="Alert"]',
        '[data-smrt-component="Badge"]',
        'input[name="name"]',
      ]) {
        expect(await style(page, selector, 'border-top-color'), selector).toBe(
          canvasText,
        );
        expect(
          isInvisibleShadow(await style(page, selector, 'box-shadow')),
          selector,
        ).toBe(true);
      }
    });

    test('an opened modal has no backdrop blur and a visible edge', async ({
      page,
    }) => {
      await page.getByRole('button', { name: 'Open modal' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      const surfaces = await page.evaluate(() =>
        [...document.querySelectorAll('[data-smrt-component]')].map(
          (element) => getComputedStyle(element).backdropFilter,
        ),
      );
      expect(surfaces.every((value) => isNoBlur(value))).toBe(true);
      const canvasText = await systemColor(page, 'CanvasText');
      expect(
        await dialog.evaluate((el) => getComputedStyle(el).borderTopColor),
      ).toBe(canvasText);
      expect(
        isInvisibleShadow(
          await dialog.evaluate((el) => getComputedStyle(el).boxShadow),
        ),
      ).toBe(true);
    });

    test('keyboard focus shows a Highlight ring at least 2px wide', async ({
      page,
    }) => {
      const highlight = await systemColor(page, 'Highlight');
      const save = page.getByRole('button', { name: 'Save' });
      await page.locator(CARD).focus().catch(() => undefined);
      await page.keyboard.press('Tab');
      await save.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(save).toBeFocused();
      const ring = await save.evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          style: s.outlineStyle,
          width: Number.parseFloat(s.outlineWidth),
          color: s.outlineColor,
        };
      });
      expect(ring.style).toBe('solid');
      expect(ring.width).toBeGreaterThanOrEqual(2);
      expect(ring.color).toBe(highlight);
    });

    test('selected state is not carried by colour alone', async ({ page }) => {
      const highlight = await systemColor(page, 'Highlight');

      // Tabs: only the selected tab draws an indicator bar, in Highlight.
      const indicators = page.locator(`${TABS} .active-indicator`);
      const widths = await indicators.evaluateAll((els) =>
        els.map((el) => ({
          width: el.getBoundingClientRect().width,
          opacity: getComputedStyle(el).opacity,
          color: getComputedStyle(el).backgroundColor,
        })),
      );
      const shown = widths.filter((w) => w.width > 0 && w.opacity === '1');
      expect(shown).toHaveLength(1);
      expect(shown[0].color).toBe(highlight);

      // Switch: on and off tracks differ in fill and the thumb moves.
      const on = page.locator('.switch', { hasText: 'On switch' });
      const off = page.locator('.switch', { hasText: 'Off switch' });
      expect(await on.locator('.switch__track').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(highlight);
      expect(await off.locator('.switch__track').evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(highlight);
      const onX = (await on.locator('.switch__thumb').boundingBox())!.x - (await on.locator('.switch__track').boundingBox())!.x;
      const offX = (await off.locator('.switch__thumb').boundingBox())!.x - (await off.locator('.switch__track').boundingBox())!.x;
      expect(onX).toBeGreaterThan(offX);

      // Toggle: checked track fills with Highlight, unchecked does not.
      const trackBg = (label: string) =>
        page
          .locator('.toggle', { hasText: label })
          .locator('.toggle__thumb')
          .evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(await trackBg('Toggle on')).toBe(highlight);
      expect(await trackBg('Toggle off')).not.toBe(highlight);

      // Checkbox and radio: checked fills with Highlight.
      const checked = page.locator('.checkbox:has(input:checked)');
      expect(await checked.locator('.checkbox__box').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(highlight);
      const radioDot = page.locator('.radio', { hasText: 'Radio B' }).locator('.radio__mark');
      expect(await radioDot.evaluate((el) => getComputedStyle(el, '::after').backgroundColor)).toBe(highlight);
      expect(await radioDot.evaluate((el) => getComputedStyle(el, '::after').transform)).not.toBe('matrix(0, 0, 0, 0, 0, 0)');

      // Chip: selected draws a Highlight outline plain chips do not have.
      const selectedChip = page.locator('.chip.selected');
      expect(await selectedChip.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
      expect(await page.locator('.chip:not(.selected)').first().evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('none');

      // DataTable: the selected row is outlined.
      const row = page.locator('.data-table__row--selected');
      await expect(row).toHaveCount(1);
      expect(await row.evaluate((el) => getComputedStyle(el).outlineColor)).toBe(highlight);
      expect(await row.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
    });

    test('disabled controls use GrayText', async ({ page }) => {
      const grayText = await systemColor(page, 'GrayText');
      const disabled = page.locator('.switch--disabled');
      expect(await disabled.evaluate((el) => getComputedStyle(el).color)).toBe(grayText);

      // A disabled control that is also selected must not keep the enabled
      // Highlight fill: it reads GrayText on Canvas, like every other disabled control.
      const highlight = await systemColor(page, 'Highlight');
      for (const el of [
        page.locator('.segmented label.selected'),
        page.locator('.toggle-button.pressed:disabled'),
      ]) {
        const style = await el.evaluate((n) => ({ bg: getComputedStyle(n).backgroundColor, color: getComputedStyle(n).color, opacity: getComputedStyle(n).opacity }));
        expect(style.bg).not.toBe(highlight);
        expect(style.color).toBe(grayText);
        expect(style.opacity).toBe('1');
      }
    });

    test('screenshot', async ({ page }, info) => {
      await page.waitForTimeout(500); // let component transitions settle
      await page.screenshot({
        path: info.outputPath(`forced-colors-${variant}.png`),
        fullPage: true,
      });
    });
  });
}

test('[data-forced-colors] alone applies the token layer without media emulation', async ({
  page,
}) => {
  await page.goto('/e2e/forced-colors.html');
  await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
  const before = await style(page, CARD, 'border-top-color');
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-forced-colors', '');
    document.querySelector('.smrt-theme-root')?.setAttribute('data-forced-colors', '');
  });
  const canvasText = await systemColor(page, 'CanvasText');
  // Card declares `transition: all`; poll until the change settles.
  await expect
    .poll(() => style(page, CARD, 'border-top-color'))
    .toBe(canvasText);
  expect(before).not.toBe(canvasText);
  expect(isInvisibleShadow(await style(page, CARD, 'box-shadow'))).toBe(true);
  expect(
    await page.locator('.smrt-theme-root').evaluate((el) =>
      getComputedStyle(el).getPropertyValue('--smrt-focus-ring-color').trim(),
    ),
  ).toBe('Highlight');
});

test('standard colours are untouched when forced colors are off', async ({
  page,
}) => {
  await page.goto('/e2e/forced-colors.html');
  await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
  const tokens = await page.locator('.smrt-theme-root').evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      ring: s.getPropertyValue('--smrt-focus-ring-color').trim(),
      hairline: s.getPropertyValue('--smrt-hairline-color').trim(),
    };
  });
  expect(tokens.ring).not.toBe('Highlight');
  expect(tokens.hairline).not.toBe('CanvasText');
  expect(await style(page, '.active-indicator', 'background-color')).not.toBe(
    'rgba(0, 0, 0, 0)',
  );
});
