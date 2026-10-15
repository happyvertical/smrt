import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

test('commerce record composition renders stored invoice totals, related credits, and its authorized action', async ({ page }) => {
  await page.goto('/e2e/invoices/index.html?record=invoice');
  await expect(page.getByText('INV-HOST-1')).toBeVisible();
  for (const text of ['Subtotal', 'CA$100.00', 'GST 5% on CA$100.00', 'CA$5.00', 'Rounded per document', 'Total', 'CA$105.00']) await expect(page.locator('[data-money-snapshot="stored"]')).toContainText(text);
  await expect(page.getByRole('heading', { name: 'Credit notes' })).toBeVisible();
  await expect(page.getByText('CN-HOST-1')).toBeVisible();
  await page.getByLabel('More actions').click();
  await page.getByRole('button', { name: 'Create credit note' }).click();
  await expect(page.getByText('Credit action invoked: 1')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const evidence = process.env.INVOICE_EVIDENCE_DIR;
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, 'invoice-record-screen.png'), fullPage: true });
  }
});

test('credit-note record composition cannot expose a nested credit action', async ({ page }) => {
  await page.goto('/e2e/invoices/index.html?record=credit');
  await expect(page.getByText('CN-HOST-1')).toBeVisible();
  await expect(page.getByLabel('More actions')).toHaveCount(0);
  await expect(page.getByText('Credit notes')).toHaveCount(0);
});
