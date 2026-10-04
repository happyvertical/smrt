import { expect, test } from '@playwright/test';

test('keyboard editing at 390px posts native values and preserves failed draft', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
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
  expect(errors).toEqual([]);
});

test('SSR forms add rows and retain malformed values and request identity without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:5586/native');
  await page.getByLabel('Amount (CAD)').fill('malformed.12');
  await page.getByRole('button', { name: 'Add allocation row' }).click();
  await expect(page.getByLabel('Amount (CAD)')).toHaveCount(2);
  await expect(page.getByLabel('Amount (CAD)').first()).toHaveValue('malformed.12');
  await page.getByLabel('Remove this allocation').first().focus();
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Save invoice draft' }).click();
  await expect(page.getByRole('alert')).toHaveText('Rejected by server; entries retained');
  await expect(page.getByLabel('Amount (CAD)').first()).toHaveValue('malformed.12');
  await expect(page.locator('[name="requestId"]')).toHaveValue('keep-request');
  await expect(page.locator('[name="tenantId"]')).toHaveValue('keep-tenant');
  await expect(page.getByLabel('Remove this allocation').first()).toBeChecked();
  expect(errors).toEqual([]);
  await context.close();
});

for (const javaScriptEnabled of [false, true]) {
  test(`Enter saves instead of adding an allocation (JavaScript ${javaScriptEnabled})`, async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled });
    const page = await context.newPage();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:5586/${javaScriptEnabled ? 'e2e/invoices/index.html' : 'native'}`);
    const amount = page.getByLabel('Amount (CAD)');
    await amount.fill('123..45');
    const request = page.waitForRequest(req => req.url().endsWith('/save') && req.method() === 'POST');
    await amount.press('Enter');
    const payload = new URLSearchParams((await request).postData() ?? '');
    expect(payload.get('intent')).toBe('save');
    expect(payload.getAll('allocationAmount')).toEqual(['123..45']);
    await expect(page.getByLabel('Amount (CAD)')).toHaveCount(1);
    await expect(page.getByLabel('Amount (CAD)')).toHaveValue('123..45');
    expect(errors).toEqual([]);
  await context.close();
  });
}

for (const javaScriptEnabled of [false, true]) {
  test(`general invoice values, tax override and structural actions (JavaScript ${javaScriptEnabled})`, async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:5586/${javaScriptEnabled ? 'e2e/invoices/index.html' : 'native'}`);
    await expect(page.locator('form')).toHaveCount(1);
    await expect(page.locator('.summary')).toContainText('141.75');
    await page.getByLabel('Quantity', { exact: true }).fill('1.25');
    await page.getByLabel('Unit price (CAD)', { exact: true }).fill('80.00');
    await page.getByLabel('Discount type', { exact: true }).selectOption('flat');
    await page.getByLabel('Discount value', { exact: true }).fill('10');
    if (javaScriptEnabled) await expect(page.locator('.summary')).toContainText('94.50');
    await page.getByLabel('Tax mode', { exact: true }).selectOption('override');
    await page.getByLabel('Line tax (%)', { exact: true }).fill('0');
    await page.getByLabel('Description', { exact: true }).fill('Fractional consulting');
    await page.getByLabel('SKU', { exact: true }).fill('CONSULT-125');
    await page.getByLabel('Payment terms', { exact: true }).fill('Net 45');
    const sent = page.waitForRequest(request => request.url().endsWith('/save') && request.method() === 'POST');
    await page.getByRole('button', { name: 'Save invoice draft' }).click();
    const data = new URLSearchParams((await sent).postData() ?? '');
    expect(data.get('lineQuantity')).toBe('1.25'); expect(data.get('lineUnitPrice')).toBe('80.00');
    expect(data.get('lineDiscountType')).toBe('flat'); expect(data.get('lineDiscountValue')).toBe('10');
    expect(data.get('lineTaxMode')).toBe('override'); expect(data.get('lineTaxRate')).toBe('0');
    expect(data.get('lineSku')).toBe('CONSULT-125'); expect(data.get('paymentTerms')).toBe('Net 45');
    expect(data.get('requestId')).toBe('keep-request'); expect(data.get('intent')).toBe('save');
    await expect(page.locator('.summary')).toContainText('90.00');
    if (process.env.INVOICE_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.INVOICE_EVIDENCE_DIR}/general-${javaScriptEnabled}.png`, fullPage: true });
    await page.getByLabel('Quantity', { exact: true }).fill('bad.1');
    const implicit = page.waitForRequest(request => request.url().endsWith('/save') && request.method() === 'POST');
    await page.getByLabel('Quantity', { exact: true }).press('Enter');
    expect(new URLSearchParams((await implicit).postData() ?? '').get('intent')).toBe('save');
    await expect(page.getByLabel('Quantity', { exact: true })).toHaveValue('bad.1');
    await expect(page.locator('.summary')).toContainText('Totals unavailable');
    await page.getByRole('button', { name: 'Add line', exact: true }).click();
    await expect(page.getByLabel('Quantity', { exact: true })).toHaveCount(2);
    await expect(page.getByLabel('Quantity', { exact: true }).first()).toHaveValue('bad.1');
    await page.getByRole('button', { name: 'Remove line', exact: true }).last().click();
    await expect(page.getByLabel('Quantity', { exact: true })).toHaveCount(1);
    await expect(page.locator('[name=requestId]')).toHaveValue('keep-request');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  await context.close();
  });
}

test('server adapter recalculates fractional lines and ignores forged totals/default tax', async ({ request }) => {
  const fields = { customerId: 'customer-a', issuedOn: '2026-10-03', dueOn: '2026-11-03', currency: 'CAD', paymentTerms: 'Net 30', invoiceTaxRate: '0', lineKey: 'one', lineDescription: 'Service', lineSku: 'SKU', lineQuantity: '1.5', lineUnitPrice: '100.00', lineDiscountType: 'percent', lineDiscountValue: '10', lineTaxMode: 'inherit', lineTaxRate: '0', totalMinor: '1', taxMinor: '0' };
  const response = await request.post('/save', { form: fields, headers: { accept: 'application/json' } });
  expect(await response.json()).toMatchObject({ valid: true, grossMinor: 15000, discountMinor: 1500, subtotalMinor: 13500, taxMinor: 675, totalMinor: 14175 });
  const invalid = await request.post('/save', { form: { ...fields, lineQuantity: 'bad.1' }, headers: { accept: 'application/json' } });
  const result = await invalid.json();
  expect(result.valid).toBe(false); expect(result.totalMinor).toBeUndefined();
});


test('standalone line primitive recalculates and reports drafts without mutating input', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/e2e/invoices/index.html?line=1');
  await expect(page.locator('.totals')).toContainText('141.75');
  await page.getByLabel('Quantity', { exact: true }).fill('2.5');
  await expect(page.locator('.totals')).toContainText('236.25');
  await page.getByLabel('Tax mode', { exact: true }).selectOption('override');
  await page.getByLabel('Line tax (%)', { exact: true }).fill('0');
  await expect(page.locator('.totals')).toContainText('225.00');
  await expect(page.locator('[data-reported]')).toHaveText('2.5:override:0');
  await expect(page.locator('[data-original]')).toHaveText('1.5');
  await page.getByLabel('Unit price (CAD)', { exact: true }).fill('bad.price');
  await expect(page.locator('.invoice-line').getByRole('status')).toContainText('Totals unavailable');
  await expect(page.getByLabel('Unit price (CAD)', { exact: true })).toHaveValue('bad.price');
  expect(errors).toEqual([]);
});
