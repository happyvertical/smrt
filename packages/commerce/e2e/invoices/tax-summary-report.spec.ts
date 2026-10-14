import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const evidence = process.env.REPORT_EVIDENCE_DIR;

test('renders the descriptor-backed A/B report with currency-scaled minor units and supports tenant drilldown', async ({ page }) => {
  if (evidence) await mkdir(evidence, { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/e2e/invoices/index.html?report=tax-summary');
  await expect(page.getByRole('table', { name: 'Tax summary report' })).toBeVisible();
  await expect(page.getByText('$110.78', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('$44.39', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('11078', { exact: true })).toHaveCount(0);
  await expect(page.getByText('4439', { exact: true })).toHaveCount(0);
  const reportId = await page.locator('[data-testid="report-resource"]').textContent();
  expect(reportId).toMatch(/TaxSummaryReport/);
  await page.getByRole('button', { name: 'Inspect GST source' }).click();
  await expect(page.getByRole('region', { name: 'GST invoice facts' })).toContainText('$40.50');
  await expect(page.getByRole('region', { name: 'GST invoice facts' })).toContainText('$16.75');
  await expect(page.getByRole('region', { name: 'GST invoice facts' })).toContainText('$38.57');
  await expect(page.getByRole('region', { name: 'GST invoice facts' })).toContainText('$14.96');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (evidence)
    await page.screenshot({
      path: join(evidence, 'tax-summary-data-desktop.png'),
      fullPage: true,
    });
  await page.setViewportSize({ width: 375, height: 844 });
  await page.goto('/e2e/invoices/index.html?report=tax-summary');
  await expect(page.locator('.data-table__body')).toContainText('$110.78');
  await expect(page.getByRole('columnheader')).toHaveCount(9);
  await expect(page.locator('.data-table-container--phone-cards')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (evidence)
    await page.screenshot({
      path: join(evidence, 'tax-summary-data-mobile.png'),
      fullPage: true,
    });
  expect(errors).toEqual([]);
});

test('refuses a foreign-principal drilldown without exposing report facts', async ({ page }) => {
  await page.goto('/e2e/invoices/index.html?report=tax-summary');
  const id = await page.evaluate(async () => {
    const response = await fetch('/tax-summary-report.json?state=data');
    return (await response.json()).gstReportId as string;
  });
  await page.goto(`/e2e/invoices/index.html?report=tax-summary&principal=tenant-b&reportId=${encodeURIComponent(id)}`);
  await page.getByRole('button', { name: 'Inspect GST source' }).click();
  await expect(page.getByRole('alert')).toContainText('not visible to this tenant');
  await expect(page.getByRole('region', { name: 'GST invoice facts' })).toHaveCount(0);
});

test('renders empty, unknown-warning, and retryable error states without inventing report rows', async ({ page }) => {
  await page.goto('/e2e/invoices/index.html?report=tax-summary&state=empty');
  await expect(page.getByRole('table', { name: 'Tax summary report' })).toContainText('No data available');

  await page.goto('/e2e/invoices/index.html?report=tax-summary&state=unknown');
  await expect(page.getByRole('table', { name: 'Tax summary report' })).toContainText('unassigned-tax-code');

  await page.goto('/e2e/invoices/index.html?report=tax-summary&state=error');
  await expect(page.getByRole('alert')).toContainText('Tax summary source unavailable');
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('alert')).toContainText('Tax summary source unavailable');
});
