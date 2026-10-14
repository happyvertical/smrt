import { expect, test } from '@playwright/test';
import { allocateInvoiceTax, calculateInvoiceDraft } from '@happyvertical/smrt-commerce/invoices';
import { invoiceRoundingValues } from './fixture.js';

test('public browser and server entries agree with canonical model allocation', async ({ page }) => {
  await page.goto('/e2e/invoices/index.html');
  const lines = ['a', 'b'].map(id => ({ id, quantity: 1, unitPrice: 10, discount: 0, taxRate: 0.05 }));
  const expected = allocateInvoiceTax(lines);
  const result = await page.evaluate(async ({ input, values }) => {
    const api = await import('/dist/invoices.js');
    return {
      allocated: api.allocateInvoiceTax(input),
      draft: api.calculateInvoiceDraft(values, { roundingScope: 'invoice' }),
    };
  }, { input: lines, values: invoiceRoundingValues });
  expect(result.allocated).toEqual(expected);
  expect(result.allocated).toMatchObject({ subtotalMinor: 20, taxMinor: 1, totalMinor: 21 });
  expect(result.allocated.lines.map(line => line.taxMinor)).toEqual([1, 0]);
  expect(result.draft).toEqual(calculateInvoiceDraft(invoiceRoundingValues, { roundingScope: 'invoice' }));
  expect(result.draft).toMatchObject({ valid: true, subtotalMinor: 20, taxMinor: 1, totalMinor: 21 });
});
