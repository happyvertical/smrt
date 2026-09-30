import { expect, test } from '@playwright/test';

test('native context and messages require negotiated capabilities and preserve bounded metadata', async ({ page }) => {
  await page.goto('/');
  const app = page.frameLocator('iframe');
  await app.locator('#context').click();
  await expect(app.locator('#status')).toHaveText('Native context');
  const calls = await page.evaluate(() => (window as any).calls);
  const context = calls.find((call: any) => call.method === 'ui/update-model-context');
  expect(context.params.content[0]).toMatchObject({ type: 'text', _meta: { 'openai/title': 'Synthetic', 'openai/thumbnail': { src: 'https://assets.invalid/x.png' } }, annotations: { audience: ['assistant'] } });
  await app.locator('#message').click();
  await expect(app.locator('#status')).toHaveText('Native message');
});

test('absent, unknown and mobile extension capabilities preserve portable fallback', async ({ page }) => {
  for (const mode of ['absent', 'unknown', 'mobile']) {
    await page.goto(`/?mode=${mode}`);
    const app = page.frameLocator('iframe');
    await app.locator('#context').click();
    await expect(app.locator('#status')).toHaveText('Portable context');
    await app.locator('#message').click();
    await expect(app.locator('#status')).toHaveText('Portable message');
  }
});

test('upstream failure falls back without reviving disposed bridge work', async ({ page }) => {
  await page.goto('/?mode=failure');
  const app = page.frameLocator('iframe');
  await app.locator('#context').click();
  await expect(app.locator('#status')).toHaveText('Portable context');
  await app.locator('body').evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await app.locator('#message').click();
  await expect(app.locator('#status')).toHaveText('Portable message');
});
