import { expect, test } from '@playwright/test';

test('root aggregate workbench shows package metadata', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('.workbench-shell-root')).toHaveAttribute(
    'data-hydrated',
    'true',
  );
  await expect(page.locator('.tabs')).toHaveCount(0);
  await expect(page.locator('.workbench-brand')).toContainText('s-m-r-t');
  await expect(page.getByRole('heading', { name: 'Workbench' })).toBeVisible();
  await expect(page.locator('.workbench-brand')).not.toContainText(
    'workspace scope',
  );
  await expect(page.locator('.brand-badge svg')).toHaveCount(1);
  await expect(page.locator('.smrt-admin-shell')).toBeVisible();
  await expect(page.locator('#smrt-admin-shell-left-panel')).toHaveAttribute(
    'data-state',
    'expanded',
  );
  await expect(page.locator('.root-nav')).toContainText('Workspace Packages');
  await expect(page.getByTestId('workbench-tab-packages')).toContainText(
    'Content processing module for SMRT framework',
  );
  await expect(page.getByTestId('workbench-package-index')).toContainText(
    '@happyvertical/smrt-content',
  );
  await expect(page.getByTestId('workbench-package-list')).toContainText(
    '@happyvertical/smrt-content',
  );

  await page.getByRole('button', { name: 'Close navigation' }).click();
  await expect(page.locator('#smrt-admin-shell-left-panel')).toHaveAttribute(
    'data-state',
    'collapsed',
  );
  await expect(page.getByTestId('workbench-package-list')).toHaveCount(0);

  await page
    .locator('#smrt-admin-shell-left-panel')
    .getByRole('button', { name: /Packages/ })
    .click();
  await expect(page.locator('#smrt-admin-shell-left-panel')).toHaveAttribute(
    'data-state',
    'expanded',
  );
  await expect(page.getByTestId('workbench-package-list')).toBeVisible();

  await page
    .getByPlaceholder('Package name or description')
    .fill('smrt-content');
  const contentPackage = page.locator(
    '[data-workbench-package="@happyvertical/smrt-content"]',
  );
  await expect(contentPackage).toBeVisible();
  await expect(contentPackage).toHaveClass(/selected/);

  const packageIndexItem = page.locator('.package-index-item');
  await expect(packageIndexItem).toHaveCount(1);
  await packageIndexItem.click();
  await expect(page.getByTestId('workbench-tab-docs')).toBeVisible();
  await expect(page.getByTestId('workbench-document-view')).toContainText(
    '@happyvertical/smrt-content',
  );

  const sectionList = page.locator('.package-node--selected .section-list');
  await expect(sectionList).not.toContainText('Overview');
  const sectionButtons = await sectionList.locator('button').evaluateAll((buttons) =>
    buttons.map((button) => button.textContent?.trim() || ''),
  );
  expect(sectionButtons.slice(0, 4)).toEqual([
    'README.md',
    'AGENTS.md',
    'CHANGELOG.md',
    'Playground',
  ]);
  await expect(sectionList).toContainText('Playground');
  await expect(page.getByTestId('workbench-playground-entry-list')).toContainText(
    'Article Card',
  );
  await expect(page.getByTestId('workbench-route-entry-list')).toContainText(
    'Contents',
  );
  await expect(page.getByTestId('workbench-document-entry-list')).toContainText(
    'README.md',
  );
  await expect(page.getByTestId('workbench-document-entry-list')).toContainText(
    'AGENTS.md',
  );

  await sectionList.getByRole('button', { name: 'API' }).click();
  await expect(page.getByTestId('workbench-api-tabs')).toBeVisible();
  await expect(
    page
      .getByTestId('workbench-api-tabs')
      .locator('button span')
      .evaluateAll((spans) =>
        spans.map((span) => span.textContent?.trim() || ''),
      ),
  ).resolves.toEqual(['Objects', 'REST', 'MCP', 'CLI']);
  await expect(page.getByTestId('workbench-api-objects')).toContainText(
    'Content',
  );
  await expect(page.getByTestId('workbench-api-objects')).toContainText(
    'Structured content object with metadata and body text',
  );
  await expect(page.getByTestId('workbench-api-objects')).toContainText(
    'TypeDoc:',
  );
  await page.getByTestId('workbench-api-tab-rest').click();
  await expect(page.getByTestId('workbench-api-rest')).toContainText(
    'GET',
  );
  await expect(page.getByTestId('workbench-api-rest')).toContainText(
    '/api/v1/contents',
  );
  await expect(page.getByTestId('workbench-api-rest')).toContainText(
    'limit',
  );
  await expect(page.getByTestId('workbench-api-rest')).toContainText(
    'query · integer · optional',
  );
  await page.getByTestId('workbench-api-tab-mcp').click();
  await expect(page.getByTestId('workbench-api-mcp')).toContainText(
    'content_list',
  );
  await expect(page.getByTestId('workbench-api-mcp')).toContainText(
    'where',
  );
  await expect(page.getByTestId('workbench-api-mcp')).toContainText(
    'input · object · optional',
  );
  await expect(page.getByTestId('workbench-api-mcp')).toContainText(
    'contentcontributionattachmentcollection_listforcontribution',
  );
  await expect(page.getByTestId('workbench-api-mcp')).toContainText(
    'options',
  );
  await page.getByTestId('workbench-api-tab-cli').click();
  await expect(page.getByTestId('workbench-api-cli')).toContainText(
    'content:list',
  );
  await expect(page.getByTestId('workbench-api-cli')).toContainText(
    '--where',
  );
  await expect(page.getByTestId('workbench-api-cli')).toContainText(
    'option · object · optional',
  );

  await page.getByPlaceholder('Package name or description').fill('smrt-ads');
  const adsPackage = page.locator(
    '[data-workbench-package="@happyvertical/smrt-ads"]',
  );
  await expect(adsPackage).toBeVisible();
  await expect(adsPackage).toHaveClass(/selected/);

  const adsSectionList = page.locator('.package-node--selected .section-list');
  if ((await adsSectionList.count()) === 0) {
    await adsPackage.click();
  }
  await adsSectionList.getByRole('button', { name: 'API' }).click();
  await expect(page.getByTestId('workbench-api-objects')).toBeInViewport();
  await page.getByTestId('workbench-api-tab-rest').click();
  await expect(page.getByTestId('workbench-api-rest')).toBeInViewport();
  await expect(page.getByTestId('workbench-api-rest')).toContainText(
    '/api/v1/addeliverytiers',
  );
  await expect(page.getByTestId('workbench-api-rest')).toContainText(
    'limit',
  );
  await page.getByTestId('workbench-api-tab-mcp').click();
  await expect(page.getByTestId('workbench-api-mcp')).toBeInViewport();
  await expect(page.getByTestId('workbench-api-mcp')).toContainText(
    'addeliverytier_list',
  );
  await expect(page.getByTestId('workbench-api-mcp')).toContainText(
    'where',
  );
  await page.getByTestId('workbench-api-tab-cli').click();
  await expect(page.getByTestId('workbench-api-cli')).toBeInViewport();
  await expect(page.getByTestId('workbench-api-cli')).toContainText(
    'addeliverytier:list',
  );
  await expect(page.getByTestId('workbench-api-cli')).toContainText(
    '--where',
  );

  await page
    .getByPlaceholder('Package name or description')
    .fill('smrt-content');
  await expect(contentPackage).toBeVisible();
  if ((await sectionList.count()) === 0) {
    await contentPackage.click();
  }
  await page
    .getByTestId('workbench-document-entry-list')
    .getByRole('button', { name: 'README.md' })
    .click();
  await expect(page.getByTestId('workbench-tab-docs')).toBeVisible();
  await expect(page.getByTestId('workbench-document-view')).toContainText(
    '@happyvertical/smrt-content',
  );
  await expect(
    page.getByTestId('workbench-document-view').getByRole('heading', {
      name: '@happyvertical/smrt-content',
    }),
  ).toBeVisible();

  await sectionList.getByRole('button', { name: 'Examples' }).click();
  await expect(page.getByTestId('workbench-tab-examples')).toContainText(
    'Content playground module',
  );
  await sectionList.getByRole('button', { name: 'Tests/Scripts' }).click();
  await expect(page.getByTestId('workbench-tab-scripts')).toContainText(
    'pnpm --filter @happyvertical/smrt-content test',
  );

  await contentPackage.click();
  await expect(sectionList).toHaveCount(0);

  await contentPackage.click();
  await expect(sectionList).toContainText('Playground');

  await sectionList.getByRole('button', { name: 'Playground' }).click();
  await expect(page.getByTestId('workbench-tab-playground')).toBeVisible();
  await expect(page.locator('.playground-shell--embedded')).toHaveCount(1);
  await expect(page.locator('.playground-shell--embedded .sidebar')).toHaveCount(
    0,
  );
  await expect(page.getByTestId('playground-entries')).toHaveCount(0);
  await expect(page.getByTestId('playground-preview-title')).toContainText(
    'Article Card',
  );
  await page
    .getByTestId('workbench-playground-entry-list')
    .getByRole('button', { name: 'Content Editor' })
    .click();
  await expect(page.getByTestId('playground-preview-title')).toContainText(
    'Content Editor',
  );

  await sectionList.getByRole('button', { name: 'Routes', exact: true }).click();
  await page
    .getByTestId('workbench-route-entry-list')
    .getByRole('button', { name: 'Contents' })
    .click();
  await expect(page.getByTestId('workbench-tab-routes')).toBeVisible();
  await expect(page.locator('.route-list')).toHaveCount(0);
  await expect(page.getByTestId('workbench-route-stage')).toContainText(
    'Workbench Editorial Brief',
  );
  await expect(page.getByTestId('workbench-route-stage')).not.toContainText(
    'Failed to load contents',
  );
  await page
    .getByTestId('workbench-route-stage')
    .getByRole('link', { name: 'Governance', exact: true })
    .click();
  await expect(page).toHaveURL(/#content-governance$/);
  await expect(page.getByTestId('workbench-route-stage')).toContainText(
    'Manage review policies',
  );
  await page.reload();
  await expect(page.getByTestId('workbench-route-stage')).toContainText(
    'Manage review policies',
  );
  await expect(
    page.locator(
      '[data-workbench-package="@happyvertical/smrt-content"]',
    ),
  ).toHaveClass(/selected/);

  await page
    .getByPlaceholder('Package name or description')
    .fill('smrt-images');
  const imagesPackage = page.locator(
    '[data-workbench-package="@happyvertical/smrt-images"]',
  );
  await expect(imagesPackage).toBeVisible();
  await expect(imagesPackage).toHaveClass(/selected/);

  const imagesSectionList = page.locator('.package-node--selected .section-list');
  if ((await imagesSectionList.count()) === 0) {
    await imagesPackage.click();
  }

  await expect(page.getByTestId('workbench-playground-entry-list')).toContainText(
    'Image Uploader',
  );
  await expect(page.getByTestId('workbench-playground-entry-list')).toContainText(
    'Image Editor',
  );
  await expect(
    page.getByTestId('workbench-playground-entry-list'),
  ).not.toContainText('Image Studio Route');
  await expect(page.getByTestId('workbench-route-entry-list')).toContainText(
    'Image Studio',
  );
});
