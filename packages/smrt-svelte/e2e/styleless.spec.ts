import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const unstyledCss = readFileSync(
  new URL('../../smrt-ui/src/styles/unstyled.css', import.meta.url),
  'utf8',
);
const geometry = [
  'display',
  'position',
  'grid-template-columns',
  'grid-template-rows',
  'grid-area',
  'gap',
  'padding-top',
  'padding-left',
  'inset',
  'transform',
  'visibility',
];

for (const width of [390, 1280]) {
  for (const right of ['collapsed', 'expanded']) {
    test(`styleless shell preserves regions, drawers and sheets at ${width}px (${right})`, async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`/?left=expanded&right=${right}&top=expanded`);
      const shell = page.locator('[data-smrt-component="AdminShell"]');
      await expect(shell).toHaveAttribute(
        'data-viewport',
        width < 768 ? 'phone' : 'desktop',
      );
      const selectors = [
        '[data-smrt-component="AdminShell"]',
        '[data-smrt-component="AdminShell"] > main',
        '[data-smrt-component="AdminShell"] > [data-smrt-part="left-sidebar"]',
        '[data-smrt-component="AdminShell"] > [data-smrt-part="right-sidebar"]',
        '[data-smrt-component="AdminShell"] section[data-smrt-part="panel"]',
      ];
      const read = (selector: string) =>
        page
          .locator(selector)
          .first()
          .evaluate((element, properties) => {
            const style = getComputedStyle(element);
            return Object.fromEntries(
              properties.map((name) => [name, style.getPropertyValue(name)]),
            );
          }, geometry);
      const before = await Promise.all(selectors.map(read));
      expect(before[0].display).toBe('grid');
      expect(before[2].position).toBe(width < 768 ? 'absolute' : 'relative');
      expect(before[4].position).toBe('absolute');
      await page.addStyleTag({ content: unstyledCss });
      // Grid track pixels may change with the inherited font and removed borders;
      // the authored tracks, positioning and state transforms must remain.
      const after = await Promise.all(selectors.map(read));
      for (let index = 0; index < before.length; index++) {
        for (const property of [
          'display',
          'position',
          'grid-area',
          'gap',
          'padding-top',
          'padding-left',
          'transform',
          'visibility',
        ]) {
          expect(
            after[index][property],
            `${selectors[index]} ${property}`,
          ).toBe(before[index][property]);
        }
        expect(
          await page
            .locator(selectors[index])
            .first()
            .evaluate((element) => {
              const style = getComputedStyle(element);
              return [
                style.backgroundColor,
                style.borderTopWidth,
                style.borderRadius,
                style.boxShadow,
                style.transitionDuration,
              ];
            }),
        ).toEqual(['rgba(0, 0, 0, 0)', '0px', '0px', 'none', '0s']);
      }
      expect(after[0]['grid-template-columns'].split(' ')).toHaveLength(3);
      expect(errors).toEqual([]);
    });
  }
}

test('the shell catalogue toggles the production reset around a sorted Disclosure in a Card slot', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.goto('/styleless.html');
  const nested = page.locator(
    '[data-smrt-component="Card"] [data-smrt-component="Disclosure"] summary',
  );
  await expect(nested).toBeVisible();
  const read = () =>
    nested.evaluate((element) => {
      const style = getComputedStyle(element);
      return [
        style.display,
        style.gap,
        style.paddingTop,
        style.paddingBottom,
        style.minHeight,
      ];
    });
  const before = await read();
  expect(before[0]).toBe('flex');
  expect(Number.parseFloat(before[1])).toBeGreaterThan(0);
  expect(Number.parseFloat(before[2])).toBeGreaterThan(0);
  await page.getByRole('checkbox', { name: 'Apply unstyled.css' }).check();
  expect(await read()).toEqual(before);
  expect(
    await nested.evaluate((element) => getComputedStyle(element).fontFamily),
  ).toBe(
    await page
      .locator('body')
      .evaluate((element) => getComputedStyle(element).fontFamily),
  );
  await expect(page.locator('[data-smrt-component="Disclosure"]')).toHaveCSS(
    'border-bottom-width',
    '0px',
  );
  await page.getByRole('checkbox', { name: 'Apply unstyled.css' }).uncheck();
  await expect(
    page.locator('[data-smrt-component="Disclosure"]'),
  ).not.toHaveCSS('border-bottom-width', '0px');
  expect(errors).toEqual([]);
});
