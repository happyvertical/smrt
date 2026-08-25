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

async function followClientLink(page: Page, href: string) {
  await page.evaluate((target) => {
    document.querySelector('[data-testid="client-navigation"]')?.remove();
    const link = document.createElement('a');
    link.dataset.testid = 'client-navigation';
    link.href = target;
    link.textContent = 'Navigate';
    document.body.append(link);
  }, href);
  await page.locator('[data-testid="client-navigation"]').click();
}

test('controlled entry follows same-page query navigation in both directions', async ({
  page,
}) => {
  const errors = trackPlaygroundErrors(page);
  const controlledEntryId =
    '@happyvertical/smrt-content:content-editor';

  await page.goto('/');
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
  const mountedHost = await page.locator('[data-hydrated="true"]').elementHandle();
  expect(mountedHost).not.toBeNull();
  await expect(page.getByTestId('playground-selected-package')).toHaveText(
    '@happyvertical/smrt-ui',
  );

  await followClientLink(
    page,
    `/?entry=${encodeURIComponent(controlledEntryId)}`,
  );
  await expect(page).toHaveURL(
    new RegExp(`entry=${encodeURIComponent(controlledEntryId)}`),
  );
  await expect(page.getByTestId('playground-preview-title')).toHaveText(
    'Content Editor',
  );
  expect(await mountedHost?.evaluate((element) => element.isConnected)).toBe(
    true,
  );

  await followClientLink(page, '/');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('playground-selected-package')).toHaveText(
    '@happyvertical/smrt-ui',
  );
  expect(await mountedHost?.evaluate((element) => element.isConnected)).toBe(
    true,
  );

  expect(errors).toEqual([]);
});

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
  await expect(page.getByTestId('playground-package-landing')).toBeVisible();

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
      '[data-playground-landing-entry="@happyvertical/smrt-content:content-editor"]',
    )
    .click();

  await expect(
    page.getByTestId('playground-preview-title'),
  ).toHaveText('Content Editor');
  await expect(
    page.getByTestId('playground-preview-stage').getByRole('button', {
      name: 'Update Content',
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

test('shared host stays interactive while switching package previews', async ({
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
      '[data-playground-landing-entry="@happyvertical/smrt-assets:asset-grid"]',
    )
    .click();

  await expect(
    page.getByTestId('playground-preview-title'),
  ).toHaveText('Asset Grid');

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
