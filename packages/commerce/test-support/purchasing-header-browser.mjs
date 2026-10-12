import assert from 'node:assert/strict';
import { resolve } from 'node:path';
const requests = [];
export async function handleRequest(req, res, { vite, render, css }) {
  if (!req.url.startsWith('/header')) return false;
  const { default: Header } = await vite.ssrLoadModule('/src/svelte/components/PurchaseOrderHeaderForm.svelte');
  let values = { vendorId: 'missing', reference: 'PO-7', expectedDate: '', shipTo: 'Dock 2', notes: 'Call first' };
  let errors = {};
  if (req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    const data = new URLSearchParams(body); requests.push(Object.fromEntries(data));
    values = Object.fromEntries(Object.keys(values).map(name => [name, data.get(name) ?? '']));
    errors = { expectedDate: 'Invalid calendar date', vendorId: 'Vendor unavailable' };
  }
  const props = { action: '/header-post', values, errors, vendors: [{ value: 'vendor-1', label: 'North Studio' }], hiddenFields: [{ name: 'requestId', value: 'same-header-request' }] };
  const output = render(Header, { props });
  res.setHeader('Content-Type', 'text/html');
  res.end(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:16px;font-family:sans-serif}*{box-sizing:border-box}${css}</style>${output.head}</head><body><div id="header">${output.body}</div><script type="application/json" id="header-props">${JSON.stringify(props).replace(/</g, '\\u003c')}</script><script type="module" src="/test-support/purchasing-header-client.ts"></script></body></html>`);
  return true;
}
export async function run({ browser, baseUrl, evidence }) {
  for (const javaScriptEnabled of [false, true]) {
    const context = await browser.newContext({ javaScriptEnabled, viewport: { width: 390, height: 844 } });
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`${baseUrl}/header`);
    if (javaScriptEnabled) await page.waitForLoadState('networkidle');
    assert.equal(await page.getByLabel('Vendor', { exact: true }).inputValue(), 'missing');
    await page.getByLabel('Expected date (YYYY-MM-DD)').fill('2026-invalid');
    await page.getByLabel('Ship to', { exact: true }).fill('Dock 2\nEdmonton');
    await Promise.all([page.waitForEvent('load'), page.getByLabel('Reference', { exact: true }).press('Enter')]);
    assert.deepEqual(requests.at(-1), { requestId: 'same-header-request', vendorId: 'missing', reference: 'PO-7', expectedDate: '2026-invalid', shipTo: 'Dock 2\r\nEdmonton', notes: 'Call first', intent: 'saveHeader' });
    assert.equal(await page.getByLabel('Expected date (YYYY-MM-DD)').inputValue(), '2026-invalid');
    assert.equal(await page.getByText('Invalid calendar date', { exact: true }).count(), 1);
    assert.equal(await page.getByLabel('Ship to', { exact: true }).inputValue(), 'Dock 2\nEdmonton');
    await page.getByLabel('Vendor', { exact: true }).selectOption('vendor-1');
    await page.getByLabel('Expected date (YYYY-MM-DD)').fill('2026-11-02');
    await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Save header', exact: true }).click()]);
    assert.equal(requests.at(-1).vendorId, 'vendor-1');
    assert.equal(requests.at(-1).expectedDate, '2026-11-02');
    assert.equal(requests.at(-1).requestId, 'same-header-request');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: resolve(evidence, `header-${javaScriptEnabled ? 'hydrated' : 'native'}-390.png`), fullPage: true });
    if (javaScriptEnabled) {
      await page.goto(`${baseUrl}/header-enhanced`);
      await page.waitForLoadState('networkidle');
      const before = requests.length;
      await page.getByRole('button', { name: 'Save header', exact: true }).click();
      assert.equal(await page.evaluate(() => document.documentElement.dataset.submitted), 'yes');
      assert.equal(requests.length, before);
      assert.equal(new URL(page.url()).pathname, '/header-enhanced');
    }
    await context.close();
  }
  console.log('PASS: purchase header native/hydrated mobile POST, retained malformed values/errors, unavailable vendor, exact hidden identity and field payload.');
}
