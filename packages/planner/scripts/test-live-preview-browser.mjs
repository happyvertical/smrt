import { existsSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { chromium } from 'playwright-core';
import { createServer as createViteServer } from 'vite';

const planId = 'plan-12345678';
const empty = {
  $schema: 'https://s-m-r-t.dev/schemas/cookbook/v1.json',
  version: 1,
  recipes: [],
  features: [],
  policies: [],
};
let origin = '';
let attempts = 0;
let reads = 0;
const calls = [];
const preview = createHttpServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (request.method === 'OPTIONS') {
    response.writeHead(204).end();
    return;
  }
  if (request.url === `/plans/${planId}` && request.method === 'GET') {
    reads++;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ planId, state: { snapshot: { revision: 1 }, cookbook: empty } }));
    return;
  }
  if (request.url === `/plans/${planId}/commands` && request.method === 'POST') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const batch = JSON.parse(body);
    calls.push(batch);
    attempts++;
    if (attempts === 1) {
      response.writeHead(503).end('temporary outage');
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      ok: true,
      planId,
      state: { snapshot: { revision: 2 }, cookbook: batch.commands[0].input.document },
    }));
    return;
  }
  response.writeHead(404).end();
});
await new Promise((resolve) => preview.listen(0, '127.0.0.1', resolve));
const previewPort = preview.address().port;
const vite = await createViteServer({ server: { host: '127.0.0.1', port: 0 } });
await vite.listen();
origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
const executablePath = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(existsSync);
if (!executablePath) throw Error('Chrome/Chromium is required for the live preview browser test');
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto(`${origin}/?kitchenPlan=${planId}&kitchenPort=${previewPort}`);
  // Clicks before hydration are ignored; the first plan read means the app is live.
  for (let waited = 0; reads === 0; waited += 100) {
    if (waited > 20000) throw Error('live preview never read the plan');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await page.getByRole('button', { name: /Bakery/ }).click();
  await page.getByRole('button', { name: 'Use this cookbook' }).click();
  await page.getByRole('dialog', { name: 'Kitchen edit needs attention' }).waitFor({ timeout: 20000 });
  if (!(await page.locator('.shell-host').evaluate((element) => element.hasAttribute('inert')))) throw Error('app was not locked during ambiguous edit');
  const draft = await page.locator('#bridge-draft').inputValue();
  if (!draft.includes('bakery') && !draft.includes('commerce.')) throw Error(`preview draft was not preserved: ${draft.slice(0, 300)}`);
  await page.getByRole('button', { name: 'Retry same edit' }).click();
  await page.getByRole('dialog', { name: 'Kitchen edit needs attention' }).waitFor({ state: 'detached', timeout: 20000 });
  if ((await page.locator('.shell-host').getAttribute('inert')) !== null) throw Error('app stayed locked after retry');
  if (calls.length !== 2 || calls[0].id !== calls[1].id || calls[0].expectedRevision !== 1) {
    throw Error('preview retry changed its batch id or revision');
  }
  if (errors.length) throw Error(`browser errors: ${errors.join('; ')}`);
  console.log(JSON.stringify({ previewRetrySameId: true, draftPreserved: true, controlsLocked: true }));
} finally {
  await browser.close();
  await vite.close();
  await new Promise((resolve) => preview.close(resolve));
}
