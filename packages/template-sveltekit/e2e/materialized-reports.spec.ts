/** Real template route and host contract for materialized report contributors (#3940). */
import { expect, test } from './fixtures.js';

async function inspectTaxCell(
  page: import('@playwright/test').Page,
  index: number,
): Promise<number> {
  const response = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname.endsWith('/drilldown') &&
      candidate.request().method() === 'POST',
    { timeout: 10_000 },
  );
  await page
    .getByRole('button', { name: 'Inspect Tax collected' })
    .nth(index)
    .click();
  return (await response).status();
}

test('renders normalized contributors, warnings, errors, declared cells, and later pages', async ({
  ownerPage,
}) => {
  const response = await ownerPage.goto('/reports/materialized/reference-tax-summary');
  if (response?.status() !== 200)
    throw new Error(`Materialized report route returned ${response?.status()}: ${await ownerPage.locator('body').innerText()}`);

  await expect(ownerPage.getByRole('table', { name: 'Reference tax summary' })).toBeVisible();
  await expect(ownerPage.getByRole('button', { name: 'Inspect Component' })).toHaveCount(0);
  await expect(ownerPage.getByRole('button', { name: 'Inspect Currency' })).toHaveCount(0);
  await expect(ownerPage.getByRole('button', { name: 'Inspect Tax collected' })).toHaveCount(3);

  await expect(ownerPage.locator('[data-materialized-report-hydrated="true"]')).toBeVisible();
  const completeResponse = inspectTaxCell(ownerPage, 0);
  await expect(ownerPage.getByRole('status').filter({ hasText: 'Loading report details' })).toBeVisible();
  expect(await completeResponse).toBe(200);
  const drilldown = ownerPage.getByRole('region', { name: 'Report drilldown' });
  await expect(drilldown.getByRole('heading', { name: 'Report drilldown' })).toBeVisible();
  await expect(drilldown.getByText('Selected measure:')).toContainText('Tax collected');
  await expect(drilldown.getByRole('table', { name: 'Report contributors' })).toContainText('REPORT-A (invoice-a)');
  await expect(drilldown.getByRole('table', { name: 'Report contributors' })).toContainText('$810.00');
  await expect(drilldown.getByRole('table', { name: 'Report contributors' })).toContainText('$40.50');
  await expect(ownerPage.locator('pre')).toHaveCount(0);

  expect(await inspectTaxCell(ownerPage, 1)).toBe(200);
  await expect(ownerPage.getByRole('alert').filter({ hasText: 'Source data changed' })).toContainText(
    'Current source facts differ from this materialized report row.',
  );

  expect(await inspectTaxCell(ownerPage, 2)).toBe(404);
  await expect(ownerPage.getByRole('alert').filter({ hasText: 'Report drilldown unavailable' })).toContainText(
    'Report drilldown unavailable',
  );
  await expect(ownerPage.getByRole('region', { name: 'Report drilldown' })).toHaveCount(0);

  await Promise.all([
    ownerPage.waitForURL(/offset=50&limit=50/),
    ownerPage.getByRole('button', { name: 'Next page' }).click(),
  ]);
  await expect(ownerPage.getByRole('table', { name: 'Reference tax summary' })).toContainText('Final GST');
  await expect(ownerPage.getByRole('button', { name: 'Inspect Tax collected' })).toHaveCount(1);
});
