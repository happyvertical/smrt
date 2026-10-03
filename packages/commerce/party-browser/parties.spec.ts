import { expect, test } from '@playwright/test';

test('directories and details remain keyboard accessible at 390px with empty, error, and read-only states', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByTestId('customer-directory').getByRole('heading', { name: 'Clients' })).toBeVisible();
  await expect(page.getByTestId('vendor-empty').getByText('No vendors found')).toBeVisible();
  await expect(page.getByTestId('vendor-error').getByRole('alert')).toContainText('Vendor service unavailable');
  await expect(page.getByTestId('customer-detail').getByRole('link', { name: /edit/i })).toHaveCount(0);
  await expect(page.getByTestId('vendor-detail').getByRole('link', { name: /edit vendor/i })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toBeVisible();
});

test('retained values and caller payload names are present in browser FormData', async ({ page }) => {
  await page.goto('/');
  const form = page.getByTestId('customer-form').locator('form');
  await expect(form.getByRole('alert').first()).toContainText('Correct the highlighted values');
  await expect(form.locator('input[name="clientName"]')).toHaveValue('Retained Client');
  const creditLimit = form.locator('input[name="credit_limit"]');
  await expect(creditLimit).toHaveValue('1250.0oops');
  await form.getByRole('button', { name: 'Enter a currency amount' }).click();
  await expect(creditLimit).toBeFocused();

  const payload = await form.evaluate((element) =>
    Object.fromEntries(new FormData(element as HTMLFormElement).entries()),
  );
  expect(payload).toMatchObject({
    clientName: 'Retained Client',
    credit_limit: '1250.0oops',
    requestToken: 'request-123',
    expectedTenantId: 'tenant-9',
  });
});

test('native contact action posts hidden tokens and entered values with JavaScript disabled', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('/native');
  await page.locator('input[name="clientName"]').fill('Native Retained Client');
  await page.getByRole('button', { name: 'Add contact' }).click();
  await expect(page.locator('#payload')).toContainText('clientName=Native+Retained+Client');
  await expect(page.locator('#payload')).toContainText('creditLimit=1250.00');
  await expect(page.locator('#payload')).toContainText('requestToken=native-request');
  await expect(page.locator('#payload')).toContainText('expectedTenantId=tenant-native');
  await expect(page.locator('#payload')).toContainText('intent=add-native-contact');
  await context.close();
});
