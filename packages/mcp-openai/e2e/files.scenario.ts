import { expect, test } from '@playwright/test';
for (const mode of ['native', 'absent', 'unknown', 'other-tenant', 'other-owner']) {
  test(`bounded file workflow in synthetic browser: ${mode}`, async ({ page }) => {
    await page.goto(`/?mode=${mode}`); const frame = page.frameLocator('iframe');
    await expect(frame.locator('#status')).toContainText('ready');
    await frame.locator('#read').click();
    if (mode.startsWith('other-')) { await expect(frame.locator('#status')).toHaveText('denied'); return; }
    if (mode === 'absent' || mode === 'unknown') { await expect(frame.locator('#status')).toContainText('Authorized import/open/download workflow'); expect(await page.evaluate(() => (window as any).calls.filter((x: any) => x.method === 'resources/read').length)).toBe(0); return; }
    await expect(frame.locator('#status')).toContainText('synthetic');
    await frame.locator('#write').click(); await expect(frame.locator('#status')).toContainText('saved');
    await frame.locator('#read').click(); await expect(frame.locator('#status')).toContainText('synthetic edited');
    await page.evaluate(() => { (window as any).revision++; });
    await frame.locator('#write').click(); await expect(frame.locator('#status')).toContainText('conflict');
    await frame.locator('#subscribe').click(); await expect(frame.locator('#status')).toHaveText('subscribed');
    await page.evaluate(() => { (window as any).revoked=true; (window as any).notify(); });
    await expect(frame.locator('#status')).toHaveText('denied');
    await frame.locator('#read').click(); await expect(frame.locator('#status')).toHaveText('denied');
  });
}
test('oversize, MIME, write failure and user-mediated open do not bypass bounds', async ({ page }) => {
  await page.goto('/'); const frame=page.frameLocator('iframe'); await expect(frame.locator('#status')).toContainText('ready');
  await frame.locator('#open').click(); await expect(frame.locator('#status')).toHaveText('opened');
  expect(await page.evaluate(() => (window as any).calls.some((x: any) => x.method==='openai/files/open'))).toBe(true);
  await page.evaluate(() => { (window as any).payload='x'.repeat(33); }); await frame.locator('#read').click(); await expect(frame.locator('#status')).toHaveText('denied');
  await page.evaluate(() => { (window as any).payload='ok'; (window as any).mime='application/executable'; }); await frame.locator('#read').click(); await expect(frame.locator('#status')).toHaveText('denied');
  await page.goto('/?mode=failure'); await expect(frame.locator('#status')).toContainText('ready'); await frame.locator('#read').click(); await expect(frame.locator('#status')).toContainText('synthetic'); await frame.locator('#write').click(); await expect(frame.locator('#status')).toHaveText('denied');
});
test('disposal prevents stale read completion', async ({ page }) => {
  await page.goto('/?mode=slow');const frame=page.frameLocator('iframe');await expect(frame.locator('#status')).toContainText('ready');await frame.locator('#read').click();await frame.locator('#dispose').click();await page.waitForTimeout(200);await expect(frame.locator('#status')).not.toContainText('synthetic');
});
