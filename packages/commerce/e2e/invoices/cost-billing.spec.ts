import { expect, test } from '@playwright/test';

// Loading the published module graph in a browser proves the entry and every
// relative chunk remain free of hidden model/server dependencies.
test('published cost billing module graph executes exact signed arithmetic in Chromium', async ({ page }) => {
  await page.goto('/e2e/invoices/index.html');
  const result = await page.evaluate(async () => {
    const entryUrl = new URL('/dist/cost-billing.js', window.location.href).href;
    const api = await import(entryUrl);
    const markup = api.resolveCostMarkup([
      { source: 'agreement', percent: '10' },
    ]);
    const lines = [
      { id: 'a', amountMinor: 10, category: 'explicit' },
      { id: 'b', amountMinor: 10, category: 'explicit' },
    ];
    const rules = [
      {
        category: 'explicit',
        components: [{ id: 'tax', percent: '5' }],
      },
    ];
    return {
      charge: api.calculateCostBilling({
        basisMinor: 105,
        mode: 'reimbursement-plus-fee',
        markup,
      }).totalMinor,
      reversal: api.calculateCostBilling({
        basisMinor: -105,
        mode: 'reimbursement-plus-fee',
        markup,
      }).totalMinor,
      lineTax: api.calculateCostBillingTax({
        lines,
        rules,
        roundingScope: 'line',
      }).taxMinor,
      invoiceTax: api.calculateCostBillingTax({
        lines,
        rules,
        roundingScope: 'invoice',
      }).taxMinor,
    };
  });
  expect(result).toEqual({
    charge: 116,
    reversal: -116,
    lineTax: 2,
    invoiceTax: 1,
  });
});
