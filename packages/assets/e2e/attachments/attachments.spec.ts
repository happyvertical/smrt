import { expect, test } from '@playwright/test';

for (const javaScriptEnabled of [true, false]) {
  test(`native multipart upload and recovery with JavaScript=${javaScriptEnabled}`, async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:5588/${javaScriptEnabled ? 'e2e/attachments/index.html' : 'native'}`);
    const description = page.getByLabel('Description', { exact: true });
    await description.focus();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('Proof retained after denial');
    await page.locator('input[type=file]').setInputFiles({ name: 'proof.pdf', mimeType: 'application/pdf', buffer: Buffer.from('private-proof-bytes') });
    if (javaScriptEnabled) expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await description.focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Upload attachment' })).toBeFocused();
    const sent = page.waitForRequest(req => req.url().endsWith('/upload') && req.method() === 'POST');
    await page.keyboard.press('Enter');
    const request = await sent;
    expect(request.headers()['content-type']).toContain('multipart/form-data; boundary=');
    await expect(page.getByText('Upload rejected; metadata retained')).toBeVisible();
    await expect(page.getByLabel('Description', { exact: true })).toHaveValue('Proof retained after denial');
    await expect(page.locator('[name=requestId]')).toHaveValue('keep-request');
    await expect(page.locator('[name=tenantId]')).toHaveValue('keep-tenant');
    await expect(page.getByText(/Choose the file again before retrying/)).toBeVisible();
    await expect(page.locator('input[type=file]')).toHaveValue('');
    const proof = await (await page.request.get('http://127.0.0.1:5588/proof')).json();
    expect(proof).toEqual({ filename: 'proof.pdf', bytes: 'private-proof-bytes', requestId: 'keep-request', tenantId: 'keep-tenant', intent: 'upload' });
    await context.close();
  });
}
