import { expect, test } from '@playwright/test';

test('thin Svelte binding reuses registries and trusted human review, without WebMCP', async ({
  page,
}) => {
  await page.goto('/mcp-apps-binding.html');
  const view = page.frameLocator('iframe');
  await expect(view.getByText('Bridge: ready')).toBeVisible();
  const child = page
    .frames()
    .find((frame) => frame.url().endsWith('/mcp-apps-child.html'))!;
  expect(await child.evaluate(() => 'modelContext' in document)).toBe(false);
  await view.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(view.getByText('Page: 2')).toBeVisible();
  await view.getByRole('button', { name: 'Propose', exact: true }).click();
  await expect(view.getByText('Value: Original')).toBeVisible();
  await view
    .getByRole('button', { name: 'Attempt synthetic approval' })
    .click();
  await expect(view.getByText('local_gesture_required')).toBeVisible();
  await view.getByRole('button', { name: 'Apply reviewed proposal' }).click();
  await expect(view.getByText('Value: Proposed')).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as any).requests.some(
        (request: any) =>
          request.method === 'tools/list' || request.method === 'tools/call',
      ),
    ),
  ).toBe(false);
  await child.evaluate(async () => {
    (window as any).oldBridge = (window as any).bindingFixture.app.bridge;
    await (window as any).unmountFixture();
  });
  expect(
    await child.evaluate(() => (window as any).oldBridge.snapshot.state),
  ).toBe('disposed');
  expect(
    await child.evaluate(() =>
      (window as any).bindingFixture
        .stage({ value: 'late' })
        .catch((error: Error) => error.message),
    ),
  ).toContain('not mounted');
});

test.describe('shipped McpAppsBridge component', () => {
  const childFrame = (page: import('@playwright/test').Page) =>
    page
      .frames()
      .find((frame) => frame.url().endsWith('/mcp-apps-bridge-child.html'))!;

  test('offers a portable display-mode request only when the host advertises it', async ({
    page,
  }) => {
    await page.goto('/mcp-apps-bridge.html?modes=inline,fullscreen');
    const view = page.frameLocator('iframe');
    await expect(view.getByRole('heading', { name: 'Items' })).toBeVisible();
    await expect(view.getByText('State: ready')).toBeVisible();
    const region = view.getByRole('region', { name: 'Items' });
    await expect(region).toBeVisible();
    await view.getByRole('button', { name: 'Expand view' }).click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).requests
            .filter((r: any) => r.method === 'ui/request-display-mode')
            .map((r: any) => r.params.mode),
        ),
      )
      .toEqual(['fullscreen']);
    // The component is a view shell: it never calls server tools by itself
    // and never needs document.modelContext or an OpenAI helper.
    expect(
      await page.evaluate(() =>
        (window as any).requests.some((r: any) =>
          ['tools/list', 'tools/call'].includes(r.method),
        ),
      ),
    ).toBe(false);
    expect(
      await childFrame(page).evaluate(() => 'modelContext' in document),
    ).toBe(false);
  });

  test('stays inline with a status when the host lacks the mode or refuses it', async ({
    page,
  }) => {
    await page.goto('/mcp-apps-bridge.html?modes=inline');
    let view = page.frameLocator('iframe');
    await expect(view.getByText('State: ready')).toBeVisible();
    await expect(view.getByRole('status')).toHaveText(
      'Host controls are unavailable; this view remains inline.',
    );
    await expect(view.getByRole('button', { name: 'Expand view' })).toHaveCount(
      0,
    );

    await page.goto(
      '/mcp-apps-bridge.html?modes=inline,fullscreen&fail=display',
    );
    view = page.frameLocator('iframe');
    await view.getByRole('button', { name: 'Expand view' }).click();
    await expect(view.getByRole('status')).toHaveText(
      'Host controls are unavailable; this view remains inline.',
    );
    await expect(view.getByRole('button', { name: 'Expand view' })).toHaveCount(
      0,
    );
  });

  test('falls back inline when opened without an embedding host, and disposes on unmount', async ({
    page,
  }) => {
    await page.goto('/mcp-apps-bridge-child.html');
    await expect(page.getByRole('status')).toHaveText(
      'Host controls are unavailable; this view remains inline.',
    );
    await expect(page.getByRole('heading', { name: 'Items' })).toBeVisible();

    await page.goto('/mcp-apps-bridge.html?modes=inline,fullscreen');
    await expect(
      page.frameLocator('iframe').getByText('State: ready'),
    ).toBeVisible();
    const child = childFrame(page);
    await child.evaluate(async () => {
      (window as any).oldBridge = (window as any).bridgeComponent.bridge;
      await (window as any).unmountFixture();
    });
    expect(
      await child.evaluate(() => (window as any).oldBridge.snapshot.state),
    ).toBe('disposed');
  });

  test('fits a 320px view without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/mcp-apps-bridge-child.html');
    await expect(page.getByRole('heading', { name: 'Items' })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
});
