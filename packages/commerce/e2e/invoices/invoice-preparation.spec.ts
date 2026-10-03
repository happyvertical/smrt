import { expect, test } from '@playwright/test';

test('keyboard editing at 390px posts native values and preserves failed draft', async ({ page }) => {
  await page.goto('/e2e/invoices/index.html');
  const amount = page.getByLabel('Amount (CAD)');
  await amount.focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('456.78');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Space');
  await expect(page.getByLabel('Remove this allocation')).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const request = page.waitForRequest(req => req.url().endsWith('/save') && req.method() === 'POST');
  await page.getByRole('button', { name: 'Save invoice draft' }).click();
  const payload = new URLSearchParams((await request).postData() ?? '');
  expect(payload.get('allocationAmount')).toBe('456.78');
  expect(payload.get('requestId')).toBe('keep-request');
  expect(payload.get('tenantId')).toBe('keep-tenant');
  expect(payload.get('intent')).toBe('save');
  expect(payload.get('removeRow')).toBe('0');
  await expect(page.getByRole('alert')).toHaveText('Rejected by server; entries retained');
  await expect(page.getByLabel('Amount (CAD)')).toHaveValue('456.78');
  await expect(page.getByLabel('Remove this allocation')).toBeChecked();
});

test('SSR forms add rows and retain malformed values and request identity without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:5586/native');
  await page.getByLabel('Amount (CAD)').fill('malformed.12');
  await page.getByRole('button', { name: 'Add allocation row' }).click();
  await expect(page.getByLabel('Amount (CAD)')).toHaveCount(2);
  await expect(page.getByLabel('Amount (CAD)').first()).toHaveValue('malformed.12');
  await page.getByLabel('Remove this allocation').first().check();
  await page.getByRole('button', { name: 'Save invoice draft' }).click();
  await expect(page.getByRole('alert')).toHaveText('Rejected by server; entries retained');
  await expect(page.getByLabel('Amount (CAD)').first()).toHaveValue('malformed.12');
  await expect(page.locator('[name="requestId"]')).toHaveValue('keep-request');
  await expect(page.locator('[name="tenantId"]')).toHaveValue('keep-tenant');
  await expect(page.getByLabel('Remove this allocation').first()).toBeChecked();
  await context.close();
});
