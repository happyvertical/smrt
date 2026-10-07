import { expect, test } from '@playwright/test';

test('floating launcher remains usable at 320px with keyboard controls', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/previews/floating-assistant', { waitUntil: 'networkidle' });

  const launcher = page.getByRole('button', { name: 'Open assistant' });
  await launcher.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Collapse assistant' })).toBeVisible();
  const bounds = await page.locator('.floating-assistant-panel').boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(640);
  await page.keyboard.press('Escape');
  await expect(launcher).toBeFocused();
  await expect(page.locator('.floating-assistant-panel')).toHaveAttribute(
    'aria-hidden',
    'true',
  );
});

test('reduced motion disables floating panel transitions', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/previews/floating-assistant', { waitUntil: 'networkidle' });
  await expect(page.locator('.floating-assistant-panel')).toHaveCSS(
    'transition-duration',
    '0s',
  );
});


test('real controller keeps tool and action authority reachable in controls mode', async ({ page }) => {
  await page.goto('/previews/floating-assistant', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Request tool', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Host closes panel' }).click();
  await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeVisible();
  await page.getByRole('button', { name: "Don't allow" }).click();
  await expect(page.getByLabel('Decision evidence')).toContainText('"decisions":[false]');
  await page.getByRole('button', { name: 'Request tool', exact: true }).click();
  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(page.getByLabel('Decision evidence')).toContainText('"executions":1');
  await page.getByRole('button', { name: 'Preview action', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Host closes panel' }).click();
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await page.getByRole('button', { name: 'Preview action', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.getByRole('button', { name: 'Inspect decisions' }).click();
  const evidence = JSON.parse(await page.getByLabel('Decision evidence').innerText());
  expect(evidence.keys).toHaveLength(1);
  await expect(page.getByLabel('Controller mounts')).toHaveText('1');
  await expect(page.getByLabel('Message', { exact: true })).toHaveCount(0);
});

test('controls mode exposes choices, Stop, and failures', async ({ page }) => {
  await page.goto('/previews/floating-assistant', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Open assistant' }).click();
  await page.getByRole('button', { name: 'Offer choices' }).click();
  await page.getByRole('button', { name: /Compact layout/ }).click();
  await expect(page.locator('.floating-assistant-panel')).toHaveAttribute('aria-hidden', 'false');
  await page.getByRole('button', { name: 'Start work' }).click();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.locator('.floating-assistant-panel')).toHaveAttribute('aria-hidden', 'false');
  await page.getByRole('button', { name: 'Show error' }).click();
  await expect(page.getByText(/Preview failure remains visible/)).toBeVisible();
  await page.getByRole('button', { name: 'Inspect decisions' }).click();
  await expect(page.getByLabel('Decision evidence')).toContainText('"choices":["compact"]');
  await expect(page.getByLabel('Controller mounts')).toHaveText('1');
});


test('host visibility pauses polling and restores the same mounted pending decision', async ({ page }) => {
  await page.clock.install();
  await page.goto('/previews/floating-assistant', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Open assistant', exact: true }).click();
  await page.getByRole('button', { name: 'Open preview conversation' }).click();
  await page.getByRole('button', { name: 'Inspect decisions' }).click();
  const initial = JSON.parse(await page.getByLabel('Decision evidence').innerText()).loads;
  await page.clock.fastForward(15001);
  await page.getByRole('button', { name: 'Inspect decisions' }).click();
  const polling = JSON.parse(await page.getByLabel('Decision evidence').innerText()).loads;
  expect(polling).toBeGreaterThan(initial);
  await page.getByRole('button', { name: 'Hide assistant', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open assistant', exact: true })).toBeHidden();
  await expect(page.locator('.floating-assistant-panel')).toBeHidden();
  await page.clock.fastForward(30001);
  await page.getByRole('button', { name: 'Inspect decisions' }).click();
  expect(JSON.parse(await page.getByLabel('Decision evidence').innerText()).loads).toBe(polling);
  await page.getByRole('button', { name: 'Show assistant', exact: true }).click();
  await page.clock.fastForward(15001);
  await page.getByRole('button', { name: 'Inspect decisions' }).click();
  expect(JSON.parse(await page.getByLabel('Decision evidence').innerText()).loads).toBeGreaterThan(polling);
  await page.getByRole('button', { name: 'Request tool', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Hide assistant', exact: true }).click();
  await page.getByRole('button', { name: 'Host closes panel' }).click();
  await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Inspect decisions' }).click();
  expect(JSON.parse(await page.getByLabel('Decision evidence').innerText()).executions).toBe(0);
  await page.getByRole('button', { name: 'Show assistant', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeVisible();
  await page.getByRole('button', { name: "Don't allow" }).click();
  await expect(page.getByLabel('Decision evidence')).toContainText('"decisions":[false]');
  await expect(page.getByLabel('Controller mounts')).toHaveText('1');
});

for (const hidden of [false, true]) {
  test(`incoming choices reveal the existing collapsed controller (host hidden: ${hidden})`, async ({ page }) => {
    await page.goto('/previews/floating-assistant', { waitUntil: 'networkidle' });
    if (hidden) await page.getByRole('button', { name: 'Hide assistant', exact: true }).click();
    await page.getByRole('button', { name: 'Offer choices' }).click();
    const choice = page.getByRole('button', { name: /Compact layout/ });
    if (hidden) {
      await expect(choice).toBeHidden();
      await page.getByRole('button', { name: 'Show assistant', exact: true }).click();
    }
    await expect(choice).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Host closes panel' }).click();
    await page.getByRole('button', { name: 'Collapse assistant' }).click();
    await expect(page.locator('.floating-assistant-panel')).toHaveAttribute('aria-hidden', 'false');
    await page.getByRole('button', { name: 'Inspect decisions' }).click();
    await expect(page.getByLabel('Decision evidence')).toContainText('"choices":[]');
    await choice.click();
    await page.getByRole('button', { name: 'Inspect decisions' }).click();
    await expect(page.getByLabel('Decision evidence')).toContainText('"choices":["compact"]');
    await expect(page.getByLabel('Controller mounts')).toHaveText('1');
  });
}
