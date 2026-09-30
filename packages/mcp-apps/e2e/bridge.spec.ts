import { expect, test } from '@playwright/test';

test('renders list/detail, routes through the host and only opens human review', async ({ page, request }) => {
  await page.goto('/');
  const view = page.frameLocator('iframe');
  await expect(view.getByText('Synthetic opportunity summary')).toBeVisible();
  await view.getByRole('button', { name: 'Synthetic analyst role' }).click();
  await expect(view.getByText('Synthetic role details.', { exact: false })).toBeVisible();
  await view.getByRole('link', { name: 'Open human review' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).calls.some((c: any) => c.method === 'ui/open-link'))).toBe(true);
  const calls = await page.evaluate(() => (window as any).calls);
  expect(calls.filter((c: any) => c.method === 'tools/call').map((c: any) => c.params.name)).toEqual(['opportunity_list', 'opportunity_detail']);
  expect(calls.find((c: any) => c.method === 'ui/open-link').params.url).toBe('https://example.com/opportunities/synthetic-1/review');
  expect((await (await request.get('/metrics')).json()).bytes).toBeLessThan(102400);
});

test('capability absence retains full text/structured fallback and review URL', async ({ page }) => {
  await page.goto('/?headless'); const view = page.frameLocator('iframe');
  await expect(view.getByText('Synthetic opportunity summary')).toBeVisible();
  await expect(view.getByRole('button', { name: 'Synthetic analyst role' })).toBeDisabled();
  await expect(view.getByRole('link')).toHaveAttribute('href', 'https://example.com/opportunities/synthetic-1/review');
  expect(await page.evaluate(() => (window as any).calls.some((c: any) => c.method === 'tools/call'))).toBe(false);
});

test('rejects sibling messages, malformed host data and enforces CSP network/assets', async ({ page }) => {
  await page.goto('/'); const child = page.frames().find((frame) => frame.url().endsWith('/view'))!;
  await expect(page.frameLocator('iframe').getByText('Synthetic opportunity summary')).toBeVisible();
  await page.evaluate(() => {
    const sibling = document.createElement('iframe'); document.body.append(sibling);
    sibling.contentWindow!.eval(`parent.view.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{theme:'dark'}}, '*')`);
    (window as any).view.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'future' } }, '*');
  });
  await expect.poll(() => child.evaluate(() => (window as any).fixture.bridge.snapshot.hostContext)).toEqual({});
  expect(await child.evaluate(() => (window as any).fixture.blockedNetwork())).toEqual({ blocked: true, imageBlocked: true });
});

test('teardown rejects pending work and repeated mount remains independent', async ({ page }) => {
  await page.goto('/'); await expect(page.frameLocator('iframe').getByText('Synthetic opportunity summary')).toBeVisible();
  for (let i = 0; i < 3; i++) {
    const child = page.frames().find((frame) => frame.url().endsWith('/view'))!;
    await child.evaluate(() => { (window as any).pendingResult = (window as any).fixture.pending(); });
    await page.evaluate(() => (window as any).view.contentWindow.postMessage({jsonrpc:'2.0',id:'teardown',method:'ui/resource-teardown',params:{}}, '*'));
    expect(await child.evaluate(() => (window as any).pendingResult)).toContain('disposed');
    await page.evaluate(() => (window as any).view.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{theme:'dark'}}, '*'));
    expect(await child.evaluate(() => (window as any).fixture.bridge.snapshot.hostContext)).toEqual({});
    await page.evaluate(() => { (window as any).view.remove(); (window as any).mount(); });
    await expect(page.frameLocator('iframe').getByText('Synthetic opportunity summary')).toBeVisible();
  }
});

test('registered optional extension uses the bound transport and detaches on disposal', async ({ page }) => {
  await page.goto('/');
  await expect(page.frameLocator('iframe').getByText('Synthetic opportunity summary')).toBeVisible();
  await page.evaluate(() => {
    (window as any).view.remove();
    (window as any).mount({ experimental: { 'example/resources': {} } });
    addEventListener('message', (event) => {
      if (event.source !== (window as any).view.contentWindow || event.data.method !== 'example/resources/read') return;
      (window as any).view.contentWindow.postMessage({ jsonrpc: '2.0', id: event.data.id, result: { contents: [{ uri: 'test://fixture', text: 'Extension content' }] } }, '*');
    });
  });
  await expect(page.frameLocator('iframe').getByText('Synthetic opportunity summary')).toBeVisible();
  const child = page.frames().find((frame) => frame.url().endsWith('/view'))!;
  const result = await child.evaluate(async () => {
    const owner = window as any;
    owner.extensionNotifications = [];
    owner.extension = owner.fixture.bridge.registerExtension({ id: 'example.resources', capability: { path: ['experimental', 'example/resources'] }, methods: ['example/resources/read', 'example/resources/hold'], notifications: ['notifications/resources/updated'] });
    owner.extension.subscribe((method: string, params: unknown) => owner.extensionNotifications.push({ method, params }));
    return owner.extension.request('example/resources/read', { uri: 'test://fixture' });
  });
  expect(result).toEqual({ contents: [{ uri: 'test://fixture', text: 'Extension content' }] });
  await page.evaluate(() => (window as any).view.contentWindow.postMessage({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: 'test://fixture' } }, '*'));
  await expect.poll(() => child.evaluate(() => (window as any).extensionNotifications.length)).toBe(1);
  expect(await child.evaluate(() => (window as any).extension.request('example/resources/unlisted', {}).catch((error: Error) => error.message))).toContain('not registered');
  await child.evaluate(() => {
    const owner = window as any;
    owner.extensionPending = owner.extension.request('example/resources/hold', {}).catch((error: Error) => error.message);
    owner.extension.dispose();
  });
  expect(await child.evaluate(() => (window as any).extensionPending)).toMatch(/cancelled|disposed/);
  await page.evaluate(() => (window as any).view.contentWindow.postMessage({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: 'test://late' } }, '*'));
  expect(await child.evaluate(() => (window as any).extensionNotifications.length)).toBe(1);
});
