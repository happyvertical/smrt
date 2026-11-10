/**
 * Settings is a menu of sections, one page each, and the Inference and
 * Prompts sections work for the local owner: the pages load from tables the
 * first start created (`_smrt_inference_overrides`, `_smrt_prompt_overrides`,
 * `_smrt_ui_preferences`) and the owner's writes are accepted.
 */

import type { Page } from '@playwright/test';

import { expect, test } from './fixtures.js';

test.describe.configure({ mode: 'serial' });

/** Post a JSON `payload` to a page's form action, as the settings pages do. */
async function postAction(page: Page, action: string, payload: unknown) {
  return page.evaluate(
    async ({ action, payload }) => {
      const body = new FormData();
      body.set('payload', JSON.stringify(payload));
      const response = await fetch(`?/${action}`, {
        method: 'POST',
        body,
        headers: { 'x-sveltekit-action': 'true' },
      });
      return (await response.json()) as { type: string; data?: string };
    },
    { action, payload },
  );
}

test('/settings lists the sections and each is its own page', async ({
  ownerPage,
}) => {
  await ownerPage.goto('/settings', { waitUntil: 'networkidle' });
  const menu = ownerPage.getByRole('navigation', { name: 'Settings sections' });
  for (const name of [
    'Appearance',
    'Account',
    'Layout',
    'Inference',
    'Prompts',
  ]) {
    await expect(menu.getByRole('link', { name })).toBeVisible();
  }
  await expect(ownerPage.locator('[data-smrt-part="appearance"]')).toHaveCount(
    0,
  );

  await menu.getByRole('link', { name: 'Appearance' }).click();
  await ownerPage.waitForURL((url) => url.pathname === '/settings/appearance');
  await expect(ownerPage.locator('[data-smrt-part="appearance"]')).toBeVisible();
  await expect(ownerPage.locator('[data-smrt-part="layout"]')).toHaveCount(0);

  const missing = await ownerPage.goto('/settings/nonsense');
  expect(missing?.status()).toBe(404);
});

test('the Inference section loads and accepts the owner’s writes', async ({
  ownerPage,
}) => {
  await ownerPage.goto('/settings/inference', { waitUntil: 'networkidle' });
  await expect(
    ownerPage.getByTestId('inference-settings-panel'),
  ).toBeVisible();

  const tier = await postAction(ownerPage, 'saveDefaultTier', {
    scope: 'app',
    tier: 'good',
  });
  expect(tier.type).toBe('success');

  const defaults = await postAction(ownerPage, 'saveDefaults', {
    mode: 'local',
  });
  expect(defaults.type).toBe('success');

  await ownerPage.reload({ waitUntil: 'networkidle' });
  await expect(
    ownerPage.getByTestId('inference-settings-panel'),
  ).toBeVisible();
});

test('the Prompts section loads', async ({ ownerPage }) => {
  const response = await ownerPage.goto('/settings/prompts', {
    waitUntil: 'networkidle',
  });
  expect(response?.status()).toBe(200);
  await expect(
    ownerPage.locator('[data-smrt-component="PromptSettingsPanel"]'),
  ).toBeVisible();
});
