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

for (const width of [390, 768]) {
  for (const target of [48, 56]) {
    test(`touch targets ${target}px fit a ${width}px viewport`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1024 });
      await page.goto(`/e2e/density-responsive.html?target=${target}px`);
      await expect(
        page.getByRole('textbox', { name: 'Name', exact: true }),
      ).toBeVisible();
      const sizes = await page
        .locator(
          '.input:not([data-density="comfortable"]), .select, .textarea, .checkbox, .switch, .radio, .button, .filter-chip, .segmented label, .data-table__sort-button',
        )
        .evaluateAll((elements) =>
          elements.map((element) => ({
            height: element.getBoundingClientRect().height,
            width: element.getBoundingClientRect().width,
          })),
        );
      expect(sizes).toHaveLength(14);
      expect(
        sizes.every((size) => size.height >= target && size.width >= target),
      ).toBe(true);
      await expect(
        page.getByRole('textbox', { name: 'Name', exact: true }),
      ).toHaveAttribute('size', '12');
      expect(
        await page
          .getByRole('textbox', { name: 'Local comfortable' })
          .evaluate((element) => element.getBoundingClientRect().height),
      ).toBeLessThan(48);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.getByRole('radio', { name: 'Two', exact: true }).click();
      await expect(
        page.getByRole('radio', { name: 'Two', exact: true }),
      ).toBeChecked();
      await expect(
        page.getByRole('radio', { name: 'Disabled', exact: true }),
      ).toBeDisabled();
    });
  }
}

test('comfortable theme preserves defaults while a local touch override expands', async ({
  page,
}) => {
  await page.goto('/e2e/density-responsive.html?density=comfortable');
  await expect(
    page.getByRole('textbox', { name: 'Name', exact: true }),
  ).toBeVisible();
  expect(
    await page
      .getByRole('textbox', { name: 'Name', exact: true })
      .evaluate((element) => element.getBoundingClientRect().height),
  ).toBeLessThan(48);
  expect(
    await page
      .getByRole('textbox', { name: 'Local touch' })
      .evaluate((element) => element.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(48);
});

test('narrow table uses priority and keeps essential columns, restores wide layout and sorting', async ({
  page,
}) => {
  await page.goto('/e2e/density-responsive.html?surface=table');
  for (const width of [390, 768, 1200, 390]) {
    await page.setViewportSize({ width, height: 1024 });
    const count = width > 800 ? 7 : Math.floor((width - 16) / 160);
    await expect(page.locator('tbody tr:first-child td')).toHaveCount(count);
    await expect(
      page.getByRole('columnheader', { name: 'Group', exact: true }),
    ).toHaveAttribute('colspan', String(count));
    await expect(
      page
        .getByRole('columnheader')
        .filter({
          has: page.getByRole('button', { name: 'Sort Column 0 ascending' }),
        }),
    ).toBeVisible();
    if (width <= 800) {
      await expect(
        page
          .getByRole('columnheader')
          .filter({
            has: page.getByRole('button', { name: 'Sort Column 6 ascending' }),
          }),
      ).toBeVisible();
      expect(
        await page
          .locator('.data-table-container')
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const sort = page.getByRole('button', { name: 'Sort Column 0 ascending' });
    expect(
      await sort.evaluate((element) => element.getBoundingClientRect().height),
    ).toBeGreaterThanOrEqual(48);
    await sort.click();
    await page
      .getByRole('button', { name: 'Sort Column 0 descending' })
      .click();
    await page
      .getByRole('button', { name: 'Clear sorting for Column 0' })
      .click();
  }
});

test('responsive table watches container width and default scroll mode retains columns', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 1024 });
  await page.goto('/e2e/density-responsive.html?surface=table');
  await page
    .locator('#app')
    .evaluate((element) => (element.style.width = '390px'));
  await expect(page.locator('tbody tr:first-child td')).toHaveCount(2);
  await page
    .locator('#app')
    .evaluate((element) => (element.style.width = '100%'));
  await expect(page.locator('tbody tr:first-child td')).toHaveCount(7);
  await page.setViewportSize({ width: 390, height: 1024 });
  await page.goto('/e2e/density-responsive.html?surface=table&mode=scroll');
  await expect(page.locator('tbody tr:first-child td')).toHaveCount(7);
  await expect(page.locator('.data-table-container')).not.toHaveClass(
    /--narrow/,
  );
});

test('segmented controls post exact values, skip disabled options and honor reset/cancellation', async ({
  page,
}) => {
  await page.goto('/e2e/density-responsive.html?surface=segments');
  const posted = () =>
    page
      .locator('form')
      .evaluate((form) => new FormData(form as HTMLFormElement).get('kind'));
  expect(await posted()).toBe('one');
  await expect(page.getByRole('radiogroup', { name: 'Kind' })).toHaveAttribute(
    'tabindex',
    '-1',
  );
  await page.getByRole('button', { name: 'Reset' }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('radio', { name: 'One', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Reset' })).toBeFocused();
  await page.getByRole('radio', { name: 'One', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: 'Zero' })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Zero' })).toBeFocused();
  await expect(page.locator('[data-bound-value]')).toHaveAttribute(
    'data-bound-type',
    'number',
  );
  expect(await posted()).toBe('0');
  await page.getByRole('button', { name: 'Reset' }).click();
  await expect(page.locator('[data-bound-value]')).toHaveText('one');
  expect(await posted()).toBe('one');
  await page.getByRole('radio', { name: 'Zero' }).click();
  await expect(page.getByRole('radio', { name: 'Zero' })).toBeChecked();
  await expect(page.locator('[data-bound-value]')).toHaveText('0');
  await page
    .locator('form')
    .evaluate((form) =>
      form.addEventListener('reset', (event) => event.preventDefault()),
    );
  await page.getByRole('button', { name: 'Reset' }).click();
  await expect(page.getByRole('radio', { name: 'Zero' })).toBeChecked();
  await expect(page.locator('[data-bound-value]')).toHaveText('0');
  expect(await posted()).toBe('0');
});

test('required segmented controls reject unknown/disabled values and exclude disabled fieldsets', async ({
  page,
}) => {
  for (const query of [
    'initial=missing',
    'initial=off',
    'initial=missing&nameless',
    'outerDisabled',
  ]) {
    await page.goto(`/e2e/density-responsive.html?surface=segments&${query}`);
    await expect(
      page.getByRole('radio', { name: 'One', exact: true }),
    ).toBeAttached();
    const state = await page.locator('form').evaluate((form) => ({
      values: [...new FormData(form as HTMLFormElement).entries()],
      valid: (form as HTMLFormElement).checkValidity(),
    }));
    expect(state.values).toEqual([]);
    expect(state.valid).toBe(query === 'outerDisabled');
    if (query === 'initial=missing&nameless') {
      await page.getByRole('radio', { name: 'Zero' }).click();
      expect(
        await page
          .locator('form')
          .evaluate((form) => (form as HTMLFormElement).checkValidity()),
      ).toBe(true);
      expect(
        await page
          .locator('form')
          .evaluate((form) => [
            ...new FormData(form as HTMLFormElement).entries(),
          ]),
      ).toEqual([]);
    }
  }
});
