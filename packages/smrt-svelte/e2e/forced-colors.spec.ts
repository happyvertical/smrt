import { expect, type Page, test } from '@playwright/test';

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

function invisibleShadow(value: string) {
  return value === 'none' || !/rgba?\((?!0, 0, 0, 0\))/.test(value);
}

function noBlur(value: string) {
  return (
    value === 'none' ||
    (/blur\(0px\)/.test(value) && !/blur\([1-9]/.test(value))
  );
}

const SHELL = '/forced-colors.html?account-menu';

test.describe('shell under forced-colors: active', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
  });

  test('regions draw CanvasText edges with no shadow or blur', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(SHELL);
    const left = page.locator('.smrt-admin-shell__edge--left');
    await expect(left).toBeVisible();
    const canvasText = await systemColor(page, 'CanvasText');
    for (const [selector, side] of [
      ['.smrt-admin-shell__edge--left', 'border-inline-end-color'],
      ['.smrt-admin-shell__edge--top', 'border-block-end-color'],
    ] as const) {
      const style = await page
        .locator(selector)
        .first()
        .evaluate((el, prop) => {
          const s = getComputedStyle(el);
          return {
            color: s.getPropertyValue(prop),
            shadow: s.boxShadow,
            blur: s.backdropFilter,
          };
        }, side);
      expect(style.color, selector).toBe(canvasText);
      expect(invisibleShadow(style.shadow), selector).toBe(true);
      expect(noBlur(style.blur), selector).toBe(true);
    }
    await page.screenshot({
      path: test.info().outputPath('shell-forced-colors-desktop.png'),
    });
  });

  test('selected nav row keeps a Highlight start bar that other rows lack', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(SHELL);
    const highlight = await systemColor(page, 'Highlight');
    const bar = (selector: string) =>
      page
        .locator(selector)
        .first()
        .evaluate((el) => {
          const s = getComputedStyle(el, '::before');
          return {
            content: s.content,
            color: s.backgroundColor,
            width: Number.parseFloat(s.width),
          };
        });
    const selected = await bar('.smrt-tenant-nav a[aria-current="page"]');
    expect(selected.content).not.toBe('none');
    expect(selected.color).toBe(highlight);
    expect(selected.width).toBeGreaterThan(0);
    const other = await bar('.smrt-tenant-nav a:not([aria-current="page"])');
    expect(other.content).toBe('none');
    const weights = await page.evaluate(() => ({
      selected: getComputedStyle(
        document.querySelector('.smrt-tenant-nav a[aria-current="page"]')!,
      ).fontWeight,
      other: getComputedStyle(
        document.querySelector(
          '.smrt-tenant-nav a:not([aria-current="page"])',
        )!,
      ).fontWeight,
    }));
    expect(Number(weights.selected)).toBeGreaterThan(Number(weights.other));
  });

  test('keyboard focus rings are Highlight and at least 2px on nav and header controls', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(SHELL);
    const highlight = await systemColor(page, 'Highlight');
    const targets = [
      page.locator('.smrt-tenant-nav a').first(),
      page.locator('.smrt-workspace-account-menu__trigger').first(),
    ];
    for (const target of targets) {
      await target.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(target).toBeFocused();
      const ring = await target.evaluate((el) => {
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
    }
  });

  test('account trigger shows an open state beyond colour', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(SHELL);
    const trigger = page
      .locator('.smrt-workspace-account-menu__trigger')
      .first();
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await page.mouse.move(0, 0);
    await page.locator('main, body').first().hover();
    const outline = await trigger.evaluate(
      (el) => getComputedStyle(el).outlineStyle,
    );
    expect(outline).toBe('solid');
  });

  test('phone tab bar marks the current tab beyond colour and has no blur', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/forced-colors.html?tabs#queue');
    const highlight = await systemColor(page, 'Highlight');
    const bar = page.locator('.smrt-phone-bottom-bar');
    await expect(bar).toBeVisible();
    const active = bar.locator('.smrt-phone-bottom-bar__item.active');
    await expect(active).toHaveCount(1);
    expect(
      await active
        .locator('.smrt-phone-bottom-bar__icon')
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe(highlight);
    const inactive = bar
      .locator('.smrt-phone-bottom-bar__item:not(.active)')
      .first();
    expect(
      await inactive
        .locator('.smrt-phone-bottom-bar__icon')
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    ).not.toBe(highlight);
    const weights = await page.evaluate(() => [
      getComputedStyle(
        document.querySelector('.smrt-phone-bottom-bar__item.active')!,
      ).fontWeight,
      getComputedStyle(
        document.querySelector('.smrt-phone-bottom-bar__item:not(.active)')!,
      ).fontWeight,
    ]);
    expect(Number(weights[0])).toBeGreaterThan(Number(weights[1]));
    expect(
      noBlur(await bar.evaluate((el) => getComputedStyle(el).backdropFilter)),
    ).toBe(true);
    const canvasText = await systemColor(page, 'CanvasText');
    expect(
      await bar.evaluate((el) => getComputedStyle(el).borderBlockStartColor),
    ).toBe(canvasText);
    await page.screenshot({
      path: test.info().outputPath('shell-forced-colors-phone.png'),
    });
  });

  test('dock toggle in the open state is filled with Highlight', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/forced-colors.html?tabs#queue');
    const highlight = await systemColor(page, 'Highlight');
    const toggle = page.locator('.smrt-dock-toggles__button').first();
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveClass(/active/);
    expect(
      await toggle.evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe(highlight);
  });
});

test('standard colours keep the themed look when forced colors are off', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(SHELL);
  const canvasText = await systemColor(page, 'CanvasText');
  const color = await page
    .locator('.smrt-admin-shell__edge--left')
    .evaluate((el) => getComputedStyle(el).borderInlineEndColor);
  expect(color).not.toBe(canvasText);
});
