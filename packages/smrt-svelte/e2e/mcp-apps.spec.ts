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
