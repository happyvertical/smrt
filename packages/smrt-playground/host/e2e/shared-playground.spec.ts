import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

function trackPlaygroundErrors(page: Page) {
  const errors: string[] = [];

  page.on('pageerror', (error) => {
    errors.push(error.message);
  });

  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });

  return errors;
}

test('shared host renders content reference previews and governance modes', async ({
  page,
}) => {
  const errors = trackPlaygroundErrors(page);

  await page.goto('/');

  await expect(
    page.getByRole('heading', { name: 'SMRT Package Playground' }),
  ).toBeVisible();
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
  await expect(
    page.locator('[data-playground-module="@happyvertical/smrt-content"]'),
  ).toBeVisible();

  await page
    .locator('[data-playground-module="@happyvertical/smrt-content"]')
    .click();
  await expect(page.getByTestId('playground-selected-package')).toHaveText(
    '@happyvertical/smrt-content',
  );
  await expect(page.getByTestId('playground-selected-module')).toHaveText(
    'Content',
  );

  await expect(
    page.locator(
      '[data-playground-entry="@happyvertical/smrt-content:content-editor"]',
    ),
  ).toBeVisible();
  await expect(
    page.locator(
      '[data-playground-entry="@happyvertical/smrt-content:governance-manager"]',
    ),
  ).toBeVisible();

  await page
    .locator(
      '[data-playground-entry="@happyvertical/smrt-content:content-editor"]',
    )
    .click();

  await expect(
    page.getByTestId('playground-preview-title'),
  ).toHaveText('Content Editor');
  await expect(
    page.getByTestId('playground-preview-stage').getByRole('heading', {
      name: 'Edit Content',
    }),
  ).toBeVisible();

  await page
    .locator(
      '[data-playground-entry="@happyvertical/smrt-content:governance-manager"]',
    )
    .click();

  await expect(
    page.getByTestId('playground-preview-title'),
  ).toHaveText('Governance Manager');
  await expect(
    page.getByTestId('playground-preview-stage').getByRole('heading', {
      name: 'Content Governance',
    }),
  ).toBeVisible();
  await expect(page.locator('[data-playground-mode="mock"]')).toBeVisible();
  await expect(page.locator('[data-playground-mode="live"]')).toBeVisible();

  expect(errors).toEqual([]);
});

test('shared host stays interactive while switching packages with modal previews', async ({
  page,
}) => {
  const errors = trackPlaygroundErrors(page);

  await page.goto('/');
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();

  await page
    .locator('[data-playground-module="@happyvertical/smrt-assets"]')
    .click();
  await expect(page.getByTestId('playground-selected-package')).toHaveText(
    '@happyvertical/smrt-assets',
  );
  await page
    .locator(
      '[data-playground-entry="@happyvertical/smrt-assets:create-asset-modal"]',
    )
    .click();

  await expect(
    page.getByTestId('playground-preview-title'),
  ).toHaveText('Create Asset Modal');

  await page
    .locator('[data-playground-module="@happyvertical/smrt-content"]')
    .click();
  await expect(page.getByTestId('playground-selected-package')).toHaveText(
    '@happyvertical/smrt-content',
  );
  await page
    .locator(
      '[data-playground-entry="@happyvertical/smrt-content:governance-manager"]',
    )
    .click();

  await expect(
    page.getByTestId('playground-preview-title'),
  ).toHaveText('Governance Manager');
  await expect(
    page.getByTestId('playground-preview-stage').getByRole('heading', {
      name: 'Content Governance',
    }),
  ).toBeVisible();

  await page
    .locator('[data-playground-module="@happyvertical/smrt-images"]')
    .click();
  await expect(page.getByTestId('playground-selected-package')).toHaveText(
    '@happyvertical/smrt-images',
  );
  await page
    .locator('[data-playground-entry="@happyvertical/smrt-images:image-editor"]')
    .click();

  await expect(
    page.getByTestId('playground-preview-title'),
  ).toHaveText('Image Editor');

  expect(errors).toEqual([]);
});
