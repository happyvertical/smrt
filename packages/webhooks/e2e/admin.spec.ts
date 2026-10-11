import { expect, test } from '@playwright/test';
test('create, toggle, replay, and safe mutation failures use the real admin component', async ({ page }) => {
  await page.goto('/e2e/index.html');
  await page.getByLabel('Endpoint', { exact: true }).fill('https://partner.example/hook');
  await page.getByLabel('Signing secret', { exact: true }).fill('browser-secret-'.repeat(4));
  await page.getByRole('button', { name: 'Add subscription' }).click();
  await expect(page.getByLabel('Signing secret', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Disable https://partner.example/hook' }).click();
  await expect(page.getByRole('button', { name: 'Enable https://partner.example/hook' })).toBeVisible();
  await page.getByLabel('Fail operations').check();
  await page.getByRole('button', { name: 'Enable https://partner.example/hook' }).click();
  await expect(page.getByRole('alert')).toContainText('could not be completed');
  await expect(page.getByText('private failure')).toHaveCount(0);
  await page.getByLabel('Fail operations').uncheck();
  await page.getByRole('button', { name: 'Retry delivery' }).click();
  await expect(page.getByRole('cell', { name: 'pending', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry delivery' })).toHaveCount(0);
});
