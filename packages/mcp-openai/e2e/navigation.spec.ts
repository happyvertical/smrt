import { expect, test } from '@playwright/test';
test('initial and changed deep links resolve once; invalid, denied and stale replies cannot navigate', async ({ page }) => {
  await page.goto('/');
  const frame=page.frameLocator('iframe');
  await expect(frame.locator('#status')).toHaveText('/items/owned: Authorized synthetic item');
  await page.evaluate(() => (window as any).send({ 'openai/deepLink': {url:'/items/owned'} }));
  expect(await page.evaluate(() => (window as any).calls.filter((m:any)=>m.method==='tools/call').length)).toBe(1);
  await frame.getByRole('button',{name:'Expand'}).click(); await expect(frame.getByRole('button',{name:'fullscreen'})).toHaveText('fullscreen');
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
  await frame.getByRole('button',{name:'Expand'}).click();await expect(frame.getByRole('button',{name:'inline'})).toHaveText('inline');
  expect(await page.evaluate(()=>(window as any).calls.filter((m:any)=>m.method==='tools/call'||m.method==='ui/request-display-mode').length)).toBe(0);
  await expect(frame.locator('#link')).toHaveAttribute('href','https://app.example/settings');
});
test('upstream display failure preserves inline UI',async({page})=>{
  await page.goto('/?mode=failure');const frame=page.frameLocator('iframe');
  await frame.getByRole('button',{name:'Expand'}).click();await expect(frame.getByRole('button',{name:'inline'})).toHaveText('inline');
});
