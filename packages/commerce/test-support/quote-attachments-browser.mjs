/** Real Assets/editor composition through the maintained quote browser host. */
import assert from 'node:assert/strict';
const submissions = [];
export async function handleRequest(req, res, { vite, render, css }) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/attachment-composition' && !/^\/(quote|purchase)-(save|upload)$/.test(url.pathname)) return false;
  const kind = url.pathname.startsWith('/purchase-') || url.searchParams.get('kind') === 'purchase' ? 'purchase' : 'quote';
  if (req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const data = await new Request(url, { method: 'POST', headers: req.headers, body: Buffer.concat(chunks) }).formData();
    submissions.push({ path: url.pathname, data, contentType: req.headers['content-type'], bytes: data.get('file') instanceof File ? await data.get('file').text() : null });
  }
  const { default: Harness } = await vite.ssrLoadModule('/test-support/QuoteAttachmentsHarness.svelte');
  const output = render(Harness, { props: { kind } });
  res.setHeader('Content-Type', 'text/html');
  res.end(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:16px}*{box-sizing:border-box}${css}</style>${output.head}</head><body><div id="attachment-composition" data-kind="${kind}">${output.body}</div><script type="module" src="/test-support/quote-attachments-client.ts"></script></body></html>`);
  return true;
}
export async function run({ browser, baseUrl }) {
  for (const javaScriptEnabled of [false, true]) {
    const context = await browser.newContext({ javaScriptEnabled, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    for (const kind of ['quote', 'purchase']) {
      await page.goto(`${baseUrl}/attachment-composition?kind=${kind}`);
      const upload = page.locator(`form[action="/${kind}-upload"]`);
      const editor = page.locator(`form[action="/${kind}-save"]`);
      assert.equal(await page.locator('form').count(), 2);
      await upload.locator('input[type=file]').setInputFiles({ name: 'receipt.txt', mimeType: 'text/plain', buffer: Buffer.from('private receipt bytes') });
      await Promise.all([page.waitForEvent('load'), upload.getByRole('button', { name: 'Upload attachment' }).click()]);
      let submission = submissions.at(-1);
      assert.equal(submission.path, `/${kind}-upload`);
      assert.match(submission.contentType, /^multipart\/form-data;/);
      assert.equal(submission.bytes, 'private receipt bytes');
      assert.equal(submission.data.get('uploadToken'), 'upload-only');
      assert.equal(submission.data.get('intent'), 'upload');
      assert.equal(submission.data.has('editorToken'), false);
      // The now-empty required file input must not block the independent editor.
      await Promise.all([page.waitForEvent('load'), editor.locator('button[type=submit]').first().click()]);
      submission = submissions.at(-1);
      assert.equal(submission.path, `/${kind}-save`);
      assert.equal(submission.data.get('editorToken'), 'editor-only');
      assert.equal(submission.data.has('uploadToken'), false);
      assert.equal(submission.data.has('file'), false);
      assert.equal(submission.data.get('intent'), kind === 'quote' ? 'save' : 'review');
      assert.equal(submission.data.get(kind === 'quote' ? 'total' : 'allocationAmount'), '12.50');
      assert.deepEqual(errors, []);
    }
    await context.close();
  }
  console.log('PASS: quote/purchase actual Assets uploads and editor actions independent; native and hydrated; multipart bytes/tokens, 390px.');
}
