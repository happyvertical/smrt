import assert from 'node:assert/strict';
import { resolve } from 'node:path';

const version = { id: 'version-retained', kind: 'customer-estimate', label: 'Estimate 2', status: 'Pending', counterparty: 'Customer', total: { amountMinor: 125050, currency: 'CAD', minorUnitDigits: 2 } };
const posted = [];
export async function handleRequest(req, res, { vite, render, css }) {
  if (req.url === '/pricing-demo') {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div><script type="module" src="/test-support/pricing-client.ts"></script></body></html>`);
    return true;
  }
  if (!['/pricing-native', '/pricing-readonly', '/pricing-post', '/pricing-review'].includes(req.url)) return false;
  const { default: Decision } = await vite.ssrLoadModule('/src/svelte/components/PricingVersionDecision.svelte');
  let reason = 'Review retained source', error = '';
  let hiddenFields = [{ name: 'requestId', value: 'pricing-request' }, { name: 'versionId', value: version.id }, { name: 'sourceId', value: 'source-a' }, { name: 'sourceId', value: 'source-b' }];
  if (req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    const data = new URLSearchParams(body); posted.push({ path: req.url, entries: [...data.entries()] });
    reason = data.get('reason') ?? '';
    hiddenFields = [...data.entries()].filter(([name]) => !['reason', 'intent'].includes(name)).map(([name, value]) => ({ name, value }));
    error = 'The source changed. Retain this request for review.';
  }
  const output = render(Decision, { props: { version, action: '/pricing-post', reason, error, hiddenFields, readOnly: req.url === '/pricing-readonly', actions: [{ label: 'Review decision', name: 'intent', value: 'review', formAction: '/pricing-review' }] } });
  res.setHeader('Content-Type', 'text/html');
  res.end(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:16px;font-family:sans-serif}*{box-sizing:border-box}${css}</style>${output.head}</head><body>${output.body}</body></html>`);
  return true;
}
export async function run({ browser, baseUrl, evidence }) {
  const native = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const page = await native.newPage();
  await page.goto(`${baseUrl}/pricing-native`);
  await page.getByLabel('Decision reason').fill('Retained keyboard reason');
  await page.getByRole('button', { name: 'Review decision' }).focus();
  await Promise.all([page.waitForURL('**/pricing-review'), page.keyboard.press('Enter')]);
  assert.equal(posted.at(-1).path, '/pricing-review');
  assert.deepEqual(posted.at(-1).entries.filter(([name]) => name === 'sourceId'), [['sourceId', 'source-a'], ['sourceId', 'source-b']]);
  assert.equal(await page.getByLabel('Decision reason').inputValue(), 'Retained keyboard reason');
  assert.equal(await page.locator('[name=requestId]').inputValue(), 'pricing-request');
  const first = JSON.stringify(posted.at(-1));
  await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Review decision' }).click()]);
  assert.equal(JSON.stringify(posted.at(-1)), first);
  await page.screenshot({ path: resolve(evidence, 'pricing-native-390.png'), fullPage: true });
  await page.goto(`${baseUrl}/pricing-readonly`);
  assert.equal(await page.locator('form').count(), 0);
  await native.close();
  const client = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const demo = await client.newPage(); const errors = [];
  demo.on('pageerror', error => errors.push(String(error)));
  await demo.goto(`${baseUrl}/pricing-demo`);
  await demo.getByLabel('Decision reason').fill('Keep this failed preview');
  await demo.getByRole('button', { name: 'Preview rejection recovery' }).click();
  await demo.getByRole('alert').waitFor();
  assert.equal(await demo.getByLabel('Decision reason').inputValue(), 'Keep this failed preview');
  assert.equal(await demo.locator('[name=requestId]').inputValue(), 'preview-retained-request');
  assert.equal(await demo.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await demo.getByRole('button', { name: 'Show read-only view' }).click();
  assert.equal(await demo.getByLabel('Decision reason').count(), 0);
  assert.deepEqual(errors, []);
  await client.close();
  console.log('PASS pricing: exact native intent/URL/repeated tokens and retry, JS-disabled keyboard, hydrated error recovery/read-only, 390px.');
}
