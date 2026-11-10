import { expect, test } from '@playwright/test';

test('radio selection survives removal of the theme layer', async ({ page }) => {
  await page.goto('/e2e/forced-colors.html');
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none; animation: none; }' });
  const radio = page.locator('[data-smrt-component="Radio"]', { hasText: 'Radio B' });
  const marker = radio.locator('[data-smrt-part="control"]');
  const transform = () => marker.evaluate((element) => getComputedStyle(element, '::after').transform);
  await expect(radio.locator('input')).toBeChecked();
  expect(await transform()).toBe('matrix(1, 0, 0, 1, 0, 0)');

  // The candidate reset removes paint and motion while preserving control state.
  const target = ':where([data-smrt-component="Radio"], [data-smrt-component="Radio"] *):not(#smrt-layer-test):not(#smrt-layer-test):not(#smrt-layer-test)';
  await page.addStyleTag({ content: `@layer smrt.theme { ${target}, ${target}::before, ${target}::after { all: revert-layer; } }` });
  expect(await transform()).toBe('matrix(1, 0, 0, 1, 0, 0)');
  expect(await radio.locator('input').evaluate((element) => getComputedStyle(element).opacity)).toBe('0');
  await page.getByRole('radio', { name: 'Radio A', exact: true }).check({ force: true });
  expect(await transform()).toBe('matrix(0, 0, 0, 0, 0, 0)');
});


test('breadcrumb separators survive removal of the theme layer', async ({ page }) => {
  await page.goto('/e2e/density-responsive.html?surface=layout');
  const crumb = page.locator('[data-smrt-component="PageHeader"] [data-smrt-part="list"] li').nth(1);
  const content = () => crumb.evaluate((element) => getComputedStyle(element, '::before').content);
  expect(await content()).toBe('"/"');
  await page.addStyleTag({ content: '@layer smrt.theme { [data-smrt-component="PageHeader"] li:not(#smrt-layer-test)::before { all: revert-layer; } }' });
  expect(await content()).toBe('"/"');
});
