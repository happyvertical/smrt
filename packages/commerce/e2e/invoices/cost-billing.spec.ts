import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Loading the published entry as a browser module also proves it has no hidden
// model/server imports. A relative bundle dependency would fail this import.
test('standalone cost billing executes exact signed arithmetic in Chromium', async ({ page }) => {
  const source = await readFile(
    new URL(import.meta.resolve('@happyvertical/smrt-commerce/cost-billing')),
    'utf8',
  );
  const result = await page.evaluate(async (code) => {
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    try {
      const api = await import(url);
      const markup = api.resolveCostMarkup([{ source: 'agreement', percent: '10' }]);
      const lines = [
        { id: 'a', amountMinor: 10, category: 'explicit' },
        { id: 'b', amountMinor: 10, category: 'explicit' },
      ];
      const rules = [{ category: 'explicit', components: [{ id: 'tax', percent: '5' }] }];
      return {
        charge: api.calculateCostBilling({ basisMinor: 105, mode: 'reimbursement-plus-fee', markup }).totalMinor,
        reversal: api.calculateCostBilling({ basisMinor: -105, mode: 'reimbursement-plus-fee', markup }).totalMinor,
        lineTax: api.calculateCostBillingTax({ lines, rules, roundingScope: 'line' }).taxMinor,
        invoiceTax: api.calculateCostBillingTax({ lines, rules, roundingScope: 'invoice' }).taxMinor,
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  }, source);
  expect(result).toEqual({ charge: 116, reversal: -116, lineTax: 2, invoiceTax: 1 });
});
