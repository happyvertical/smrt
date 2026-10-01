import { expect, test } from '@playwright/test';
test('initial and changed deep links resolve once; invalid, denied and stale replies cannot navigate', async ({ page }) => {
  await page.goto('/');
  const frame=page.frameLocator('iframe');
  await expect(frame.locator('#status')).toHaveText('/items/owned: Authorized synthetic item');
  await page.evaluate(() => (window as any).send({ 'openai/deepLink': {url:'/items/owned'} }));
  expect(await page.evaluate(() => (window as any).calls.filter((m:any)=>m.method==='tools/call').length)).toBe(1);
  await frame.getByRole('button').click(); await expect(frame.getByRole('button')).toHaveText('fullscreen');
  await page.evaluate(() => (window as any).send({ 'openai/deepLink': {url:'//evil.test'} }));
  await expect(frame.locator('#status')).toHaveText('Inline fallback: invalid');
  await page.evaluate(() => (window as any).send({ 'openai/deepLink': {url:'/items/denied'} }));
  await expect(frame.locator('#status')).toHaveText('Inline fallback: denied');
  await page.evaluate(() => { (window as any).send({'openai/deepLink':{url:'/items/slow'}}); (window as any).send({'openai/deepLink':{url:'/items/latest'}}); });
  await expect(frame.locator('#status')).toHaveText('/items/latest: Authorized synthetic item');
  await page.waitForTimeout(150);
  await expect(frame.locator('#status')).toHaveText('/items/latest: Authorized synthetic item');
  await expect(frame.locator('#link')).toHaveAttribute('href','https://app.example/settings');
});
for(const mode of ['absent','unknown']) test(`${mode} capabilities preserve inline and ordinary application link`, async ({page})=>{
  await page.goto(`/?mode=${mode}`);const frame=page.frameLocator('iframe');
  await expect(frame.locator('#status')).toHaveText('Inline fallback: unavailable');
  await frame.getByRole('button').click();await expect(frame.getByRole('button')).toHaveText('inline');
  expect(await page.evaluate(()=>(window as any).calls.filter((m:any)=>m.method==='tools/call'||m.method==='ui/request-display-mode').length)).toBe(0);
  await expect(frame.locator('#link')).toHaveAttribute('href','https://app.example/settings');
});
test('upstream display failure preserves inline UI',async({page})=>{
  await page.goto('/?mode=failure');const frame=page.frameLocator('iframe');
  await frame.getByRole('button').click();await expect(frame.getByRole('button')).toHaveText('inline');
});

for (const mode of ['present', 'pending']) test(`restores route A after invalidation (${mode})`, async ({ page }) => {
  await page.goto(`/?mode=${mode}`);
  const frame = page.frameLocator('iframe');
  await expect.poll(() => page.evaluate(() => (window as any).calls.filter((m: any) => m.method === 'tools/call').length)).toBe(1);
  if (mode === 'present') await expect(frame.locator('#status')).toHaveText('/items/owned: Authorized synthetic item');
  await page.evaluate(() => (window as any).send({ 'openai/deepLink': { url: '//evil.test' } }));
  await expect(frame.locator('#status')).toHaveText('Inline fallback: invalid');
  if (mode === 'pending') await expect.poll(() => page.evaluate(() => (window as any).calls.filter((m: any) => m.method === 'notifications/cancelled').length)).toBe(1);
  await page.evaluate(() => (window as any).send({ 'openai/deepLink': { url: '/items/owned' } }));
  await expect(frame.locator('#status')).toHaveText('/items/owned: Authorized synthetic item');
  expect(await page.evaluate(() => (window as any).calls.filter((m: any) => m.method === 'tools/call').length)).toBe(2);
  if (mode === 'pending') {
    await page.evaluate(() => (window as any).releaseInitial());
    await page.waitForTimeout(50);
    await expect(frame.locator('#status')).toHaveText('/items/owned: Authorized synthetic item');
  }
});


test('encoded query delimiter cannot hide traversal from the resolver', async ({ page }) => {
  await page.goto('/');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#status')).toContainText('/items/owned:');
  await page.evaluate(() => (window as any).send({ 'openai/deepLink': { url: '/safe%3F/../admin' } }));
  await expect(frame.locator('#status')).toHaveText('Inline fallback: invalid');
  expect(await page.evaluate(() => (window as any).calls.filter((m: any) => m.method === 'tools/call').length)).toBe(1);
  await page.evaluate(() => (window as any).send({ 'openai/deepLink': { url: '/safe?next=/a/../b' } }));
  await expect(frame.locator('#status')).toContainText('/safe?next=/a/../b:');
});
for (const outcome of ['result', 'denied', 'rejected']) test(`callback failure after ${outcome} is reported without a false or repeated denial`, async ({ page }) => {
  await page.goto('/');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#status')).toContainText('/items/owned:');
  const child = page.frames().find(f => f.url().endsWith('/view'))!;
  await child.evaluate(outcome => { (window as any).navigationEvents.length = 0; (window as any).throwCallback = outcome === 'result' ? 'result' : 'fallback'; }, outcome);
  await page.evaluate(outcome => (window as any).send({ 'openai/deepLink': { url: `/items/${outcome}` } }), outcome);
  await expect.poll(() => child.evaluate(() => (window as any).callbackFailures)).toEqual([`Error: ${outcome === 'result' ? 'render' : 'fallback'} failed`]);
  expect(await child.evaluate(() => (window as any).navigationEvents)).toEqual([outcome === 'result' ? 'result:/items/result' : 'fallback:denied']);
  expect(await page.evaluate(() => (window as any).calls.filter((m: any) => m.method === 'tools/call').length)).toBe(2);
  await child.evaluate(() => { (window as any).throwCallback = ''; });
  await page.evaluate(() => (window as any).send({ 'openai/deepLink': { url: '/items/recovered' } }));
  await expect(frame.locator('#status')).toContainText('/items/recovered:');
});
