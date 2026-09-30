import { expect, test } from '@playwright/test';

test('exported helpers send negotiated context and new-conversation metadata', async ({ page }) => {
  await page.goto('/');
  const app = page.frameLocator('iframe');
  await app.locator('#context').click();
  await expect(app.locator('#status')).toHaveText('Native context');
  const context = await page.evaluate(() => (window as any).calls.find((m: any) => m.method === 'ui/update-model-context'));
  expect(context.params.content[0]).toMatchObject({ type: 'text', _meta: { 'openai/title': 'Synthetic', 'openai/thumbnail': { src: 'https://assets.invalid/x.png' } }, annotations: { audience: ['assistant'] } });
  await app.locator('#message-new').click();
  await expect(app.locator('#status')).toHaveText('Native message');
  const messages = await page.evaluate(() => (window as any).calls.filter((m: any) => m.method === 'ui/message'));
  expect(messages).toHaveLength(1);
  expect(messages[0].params).toEqual({ role: 'user', content: [{ type: 'text', text: 'Synthetic message' }], _meta: { 'openai/message': { target: 'new', send: true } } });
});

for (const mode of ['absent', 'unknown', 'mobile']) test(`exported helpers use actual portable context and active-message wires (${mode})`, async ({ page }) => {
  await page.goto(`/?mode=${mode}`);
  const app = page.frameLocator('iframe');
  await app.locator('#context').click();
  await expect(app.locator('#status')).toHaveText('Portable context');
  const contexts = await page.evaluate(() => (window as any).calls.filter((m: any) => m.method === 'ui/update-model-context'));
  expect(contexts.map((m: any) => m.params)).toEqual([{ content: [{ type: 'text', text: 'Private synthetic context' }], structuredContent: { selection: 'replacement' } }]);
  await app.locator('#message').click();
  await expect(app.locator('#status')).toHaveText('Portable message');
  expect(await page.evaluate(() => (window as any).calls.filter((m: any) => m.method === 'ui/message').map((m: any) => m.params))).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Synthetic message' }] }]);
});

test('native context rejection performs and awaits a real portable replacement', async ({ page }) => {
  await page.goto('/?mode=failure');
  const app = page.frameLocator('iframe');
  await app.locator('#context').click();
  await expect(app.locator('#status')).toHaveText('Portable context');
  const contexts = await page.evaluate(() => (window as any).calls.filter((m: any) => m.method === 'ui/update-model-context'));
  expect(contexts).toHaveLength(2);
  expect(contexts[0].params.content[0]._meta).toHaveProperty('openai/title', 'Synthetic');
  expect(contexts[1].params).toEqual({ content: [{ type: 'text', text: 'Private synthetic context' }], structuredContent: { selection: 'replacement' } });
  expect(await page.evaluate(() => (window as any).portableContextReplacements)).toEqual([contexts[1].params]);
});

for (const action of ['abort', 'dispose']) test(`native failure cannot revive portable context after ${action}`, async ({ page }) => {
  await page.goto('/?mode=held-failure');
  const app = page.frameLocator('iframe');
  await app.locator('#context').click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).releaseNativeFailure)).toBe('function');
  if (action === 'abort') await app.locator('#abort-context').click();
  else await app.locator('body').evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect(app.locator('#status')).toHaveText('Context rejected');
  await page.evaluate(() => (window as any).releaseNativeFailure());
  await page.waitForTimeout(50);
  expect(await page.evaluate(() => (window as any).calls.filter((m: any) => m.method === 'ui/update-model-context').length)).toBe(1);
  expect(await page.evaluate(() => (window as any).portableContextReplacements)).toEqual([]);
});

for (const mode of ['absent', 'unknown', 'missing-callback']) test(`new-conversation target rejects before any send (${mode})`, async ({ page }) => {
  await page.goto(`/?mode=${mode}`);
  const app = page.frameLocator('iframe');
  await app.locator(mode === 'missing-callback' ? '#message-new-missing' : '#message-new').click();
  await expect(app.locator('#status')).toHaveText('Message rejected');
  expect(await page.evaluate(() => (window as any).calls.filter((m: any) => m.method === 'ui/message'))).toEqual([]);
});
