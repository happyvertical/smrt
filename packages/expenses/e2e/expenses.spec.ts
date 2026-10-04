import { expect, test } from '@playwright/test';
for (const javaScriptEnabled of [true, false]) {
  test(`expense correction retains native values and identity with JavaScript=${javaScriptEnabled}`, async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:5589/${javaScriptEnabled ? 'e2e/index.html' : 'native'}`);
    await page.getByLabel('Amount', { exact: true }).fill('123.bad');
    await page.getByLabel('Incurred date', { exact: true }).fill('invalid-date');
    await page.getByLabel('Correction reason', { exact: true }).focus();
    await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type('Keep corrected description');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Save correction' })).toBeFocused();
    if (javaScriptEnabled) expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const sent = page.waitForRequest(req => req.url().endsWith('/save') && req.method() === 'POST');
    await page.keyboard.press('Enter');
    const data = new URLSearchParams((await sent).postData() ?? '');
    expect(data.get('amount')).toBe('123.bad'); expect(data.get('incurredOn')).toBe('invalid-date');
    expect(data.get('intent')).toBe('save'); expect(data.get('requestId')).toBe('same-request'); expect(data.get('tenantId')).toBe('same-tenant'); expect(data.get('predecessorId')).toBe('same-predecessor');
    await expect(page.getByText('Expense denied; entries retained')).toBeVisible();
    await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('123.bad');
    await expect(page.getByLabel('Incurred date', { exact: true })).toHaveValue('invalid-date');
    await expect(page.getByLabel('Correction reason', { exact: true })).toHaveValue('Keep corrected description');
    await expect(page.locator('[name=requestId]')).toHaveValue('same-request');
    await context.close();
  });
}

for (const javaScriptEnabled of [true, false]) {
  test(`empty review action posts to the current page with JavaScript=${javaScriptEnabled}`, async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled });
    const page = await context.newPage();
    const url = `http://127.0.0.1:5589/${javaScriptEnabled ? 'e2e/index.html?review=1' : 'native-review'}`;
    await page.goto(url);
    await expect(page.locator('form')).toHaveAttribute('action', '');
    const sent = page.waitForRequest(request => request.url() === url && request.method() === 'POST');
    await page.getByRole('button', { name: 'Reject expense' }).click();
    const data = new URLSearchParams((await sent).postData() ?? '');
    expect(data.get('intent')).toBe('reject');
    expect(data.get('requestId')).toBe('same-review');
    expect(data.get('tenantId')).toBe('same-tenant');
    await expect(page.getByText('Review denied; request retained')).toBeVisible();
    await expect(page.locator('[name=requestId]')).toHaveValue('same-review');
    expect(page.url()).toBe(url);
    await context.close();
  });
}
