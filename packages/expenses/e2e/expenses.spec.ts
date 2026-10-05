import { expect, test } from '@playwright/test';
for (const javaScriptEnabled of [true, false]) {
  test(`expense correction retains native values and identity with JavaScript=${javaScriptEnabled}`, async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:5589/${javaScriptEnabled ? 'e2e/index.html' : 'native'}`);
    await page.locator('select[name="currency"]').selectOption('JPY');
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
    expect(data.get('currency')).toBe('JPY');
    expect(data.get('intent')).toBe('save'); expect(data.get('requestId')).toBe('same-request'); expect(data.get('tenantId')).toBe('same-tenant'); expect(data.get('predecessorId')).toBe('same-predecessor');
    await expect(page.getByText('Expense denied; entries retained')).toBeVisible();
    await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('123.bad');
    await expect(page.getByLabel('Incurred date', { exact: true })).toHaveValue('invalid-date');
    await expect(page.locator('select[name="currency"]')).toHaveValue('JPY');
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

 test('touch keypad edits exact amount text and cost object posts unchanged', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:5589/e2e/index.html');
  await page.getByLabel('Amount', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Amount keypad', exact: true }).click();
  const keypad = page.getByRole('group', { name: 'Amount keypad', exact: true });
  await keypad.getByRole('button', { name: '1', exact: true }).click();
  await keypad.getByRole('button', { name: 'Decimal point' }).click();
  await keypad.getByRole('button', { name: 'Decimal point' }).click();
  await keypad.getByRole('button', { name: '2', exact: true }).click();
  await keypad.getByRole('button', { name: 'Delete last character' }).click();
  await keypad.getByRole('button', { name: '3', exact: true }).click();
  await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('1.3');
  await page.getByLabel('Amount', { exact: true }).evaluate((element: HTMLInputElement) => { element.focus(); element.setSelectionRange(2, 3); });
  await keypad.getByRole('button', { name: '9', exact: true }).click();
  await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('1.9');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const sent = page.waitForRequest(req => req.url().endsWith('/save') && req.method() === 'POST');
  await page.getByRole('button', { name: 'Save correction' }).click();
  const data = new URLSearchParams((await sent).postData() ?? '');
  expect(data.get('amount')).toBe('1.9'); expect(data.get('costObjectType')).toBe('@example/jobs:Job'); expect(data.get('costObjectId')).toBe('job-a');
 });

for (const javaScriptEnabled of [true, false]) {
  test(`queue decisions retain reason and caller identity JavaScript=${javaScriptEnabled}`, async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:5589/${javaScriptEnabled ? 'e2e/index.html?lifecycle=1' : 'native-lifecycle'}`);
    await page.getByRole('button', { name: 'Reject expense' }).click();
    expect(await page.getByLabel('Rejection reason', { exact: true }).evaluate((element: HTMLTextAreaElement) => element.validity.valueMissing)).toBe(true);
    await page.getByLabel('Rejection reason', { exact: true }).fill('Wrong receipt');
    const sent = page.waitForRequest(req => req.url().endsWith('/queue-review') && req.method() === 'POST');
    await page.getByRole('button', { name: 'Reject expense' }).click();
    const data = new URLSearchParams((await sent).postData() ?? '');
    expect(data.get('intent')).toBe('reject'); expect(data.get('reason')).toBe('Wrong receipt'); expect(data.get('expenseId')).toBe('expense-a'); expect(data.get('requestId')).toBe('queue-key');
    await expect(page.getByLabel('Rejection reason', { exact: true })).toHaveValue('Wrong receipt');
    await expect(page.getByText('Decision denied; reason retained')).toBeVisible();
    await page.getByLabel('Rejection reason', { exact: true }).fill('');
    const approved = page.waitForRequest(req => req.url().endsWith('/queue-review') && req.method() === 'POST');
    await page.getByRole('button', { name: 'Approve expense' }).click();
    expect(new URLSearchParams((await approved).postData() ?? '').get('intent')).toBe('approve');
    await context.close();
  });
  test(`receipt native file posts multipart identity JavaScript=${javaScriptEnabled}`, async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled }); const page = await context.newPage();
    await page.goto(`http://127.0.0.1:5589/${javaScriptEnabled ? 'e2e/index.html?lifecycle=1' : 'native-lifecycle'}`);
    await page.getByLabel('Receipt file', { exact: true }).setInputFiles({ name: 'receipt.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-receipt') });
    const sent = page.waitForRequest(req => req.url().endsWith('/attach') && req.method() === 'POST');
    await page.getByRole('button', { name: 'Attach receipt', exact: true }).click();
    const request = await sent; expect(request.headers()['content-type']).toContain('multipart/form-data');
    await page.waitForURL('**/attach');
    const proof = await (await page.request.get('/receipt-proof')).json();
    expect(proof.body).toContain('receipt.pdf'); expect(proof.body).toContain('%PDF-receipt'); expect(proof.body).toContain('receipt-key'); expect(proof.body).toContain('expense-a');
    await context.close();
  });
}

test('receipt CameraCapture denied state offers native picker recovery', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => { throw new DOMException('Denied', 'NotAllowedError'); } } }); });
  await page.goto('http://127.0.0.1:5589/e2e/index.html?lifecycle=1');
  await page.getByRole('button', { name: 'Use camera', exact: true }).click();
  await expect(page.locator('.camera-capture')).toHaveAttribute('data-state', 'permission-denied');
  await page.getByRole('button', { name: 'Use camera', exact: true }).click();
  await expect(page.getByLabel('Receipt file', { exact: true })).toBeVisible();
});

test('committed CameraCapture photo posts through the receipt multipart form', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => {
      const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
      const context = canvas.getContext('2d')!; context.fillStyle = 'white'; context.fillRect(0, 0, 32, 32);
      const stream = canvas.captureStream(10);
      window.setInterval(() => context.fillRect(0, 0, 32, 32), 100);
      return stream;
    } } });
  });
  await page.goto('http://127.0.0.1:5589/e2e/index.html?lifecycle=1');
  await page.getByRole('button', { name: 'Use camera', exact: true }).click();
  await expect(page.locator('.camera-capture')).toHaveAttribute('data-state', 'streaming');
  await page.locator('.camera-capture button.primary').click();
  await expect(page.locator('.camera-capture')).toHaveAttribute('data-state', 'reviewing');
  await page.locator('.camera-capture button.primary').click();
  await expect(page.locator('.camera-capture')).toHaveAttribute('data-state', 'committed');
  const sent = page.waitForRequest(req => req.url().endsWith('/attach') && req.method() === 'POST');
  await page.getByRole('button', { name: 'Attach receipt', exact: true }).click();
  const request = await sent;
  expect(request.headers()['content-type']).toContain('multipart/form-data');
  await page.waitForURL('**/attach');
  const proof = await (await page.request.get('/receipt-proof')).json();
  expect(proof.body).toContain('filename="receipt.jpg"');
  expect(proof.body).toContain('Content-Type: image/jpeg');
});
