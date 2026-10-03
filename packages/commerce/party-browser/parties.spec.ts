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

test('Enter selects save before contact row actions with JavaScript enabled and disabled', async ({ browser, page }) => {
  await page.goto('/');
  const customerForm = page.getByTestId('customer-form').locator('form');
  await customerForm.locator('input[name="clientName"]').fill('Enter saves this client');
  await Promise.all([
    page.waitForURL('**/party-submit'),
    customerForm.locator('input[name="clientName"]').press('Enter'),
  ]);
  await expect(page.locator('#payload')).toContainText('intent=save');
  await expect(page.locator('#payload')).not.toContainText('intent=addContact');
  await expect(page.locator('#payload')).not.toContainText('intent=removeContact');

  const context = await browser.newContext({ javaScriptEnabled: false });
  const nativePage = await context.newPage();
  await nativePage.goto('/native');
  await nativePage.locator('input[name="clientName"]').fill('Native Enter save');
  await Promise.all([
    nativePage.waitForURL('**/party-submit'),
    nativePage.locator('input[name="clientName"]').press('Enter'),
  ]);
  await expect(nativePage.locator('#payload')).toContainText('intent=save');
  await expect(nativePage.locator('#payload')).not.toContainText('intent=add-native-contact');
  await expect(nativePage.locator('#payload')).not.toContainText('intent=removeContact');
  await context.close();
});

test('custom action bars retain their caller-controlled default Enter intent', async ({ browser, page }) => {
  await page.goto('/');
  const form = page.getByTestId('custom-actions-form').locator('form');
  await Promise.all([
    page.waitForURL('**/party-submit'),
    form.locator('input[name="name"]').press('Enter'),
  ]);
  await expect(page.locator('#payload')).toContainText('intent=custom-save');
  await expect(page.locator('#payload')).not.toContainText('intent=removeContact');

  const context = await browser.newContext({ javaScriptEnabled: false });
  const nativePage = await context.newPage();
  await nativePage.goto('/native-custom-actions');
  await Promise.all([
    nativePage.waitForURL('**/party-submit'),
    nativePage.locator('input[name="name"]').press('Enter'),
  ]);
  await expect(nativePage.locator('#payload')).toContainText('intent=custom-save');
  await expect(nativePage.locator('#payload')).not.toContainText('intent=removeContact');
  await context.close();
});

test('invalid lead time survives browser rendering and a native contact action', async ({ browser, page }) => {
  await page.goto('/');
  const vendorForm = page.getByTestId('vendor-invalid').locator('form');
  await expect(vendorForm.locator('input[name="leadTimeDays"]')).toHaveValue('7oops');
  const payload = await vendorForm.evaluate((element) =>
    Object.fromEntries(new FormData(element as HTMLFormElement).entries()),
  );
  expect(payload.leadTimeDays).toBe('7oops');

  const context = await browser.newContext({ javaScriptEnabled: false });
  const nativePage = await context.newPage();
  await nativePage.goto('/native-vendor');
  await expect(nativePage.locator('input[name="leadTimeDays"]')).toHaveValue('7oops');
  await nativePage.getByRole('button', { name: 'Add contact' }).click();
  await expect(nativePage.locator('#payload')).toContainText('leadTimeDays=7oops');
  await expect(nativePage.locator('#payload')).toContainText('intent=addContact');
  await context.close();
});

test('playground customer form handles add, remove, and retained rejection actions', async ({ page }) => {
  await page.goto('/');
  const preview = page.getByTestId('customer-playground');
  const form = preview.locator('form');
  await form.locator('input[name="creditLimit"]').fill('12..50');
  await preview.getByRole('button', { name: 'Add contact' }).click();
  await expect(form.locator('input[name="contactId"]')).toHaveCount(2);
  await expect(preview.getByRole('alert').first()).toContainText('Demo contact added');
  await preview.getByRole('button', { name: 'Remove contact' }).last().click();
  await expect(form.locator('input[name="contactId"]')).toHaveCount(1);
  await preview.getByRole('button', { name: 'Save customer' }).click();
  await expect(preview.getByRole('alert').first()).toContainText('entered values were retained');
  await expect(form.locator('input[name="creditLimit"]')).toHaveValue('12..50');
  await expect(page).toHaveURL(/\/$/);
});
