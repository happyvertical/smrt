import {
  calculateCostBilling,
  calculateCostBillingTax,
  resolveCostMarkup,
} from '@happyvertical/smrt-commerce/cost-billing';
import { describe, expect, it } from 'vitest';
import { Expense } from '../index.js';

// Synthetic host policy, not a jurisdiction default. All amounts are minor units.
function purchase(sign = 1) {
  const expense = new Expense({ amount: sign * 11200, currency: 'CAD' });
  expense.setFinancialBreakdown({
    currency: 'CAD',
    subtotal: sign * 10000,
    taxes: [
      {
        code: 'recoverable',
        amount: sign * 500,
        recoverableAmount: sign * 500,
      },
      { code: 'nonrecoverable', amount: sign * 700, recoverableAmount: 0 },
    ],
    total: sign * 11200,
  });
  return expense;
}

const markup = () =>
  resolveCostMarkup([
    { source: 'item' },
    {
      source: 'code',
      percent: '20',
      policy: 'approved-contract',
      version: 'v1',
    },
    { source: 'section', percent: '15' },
    { source: 'job', percent: '25' },
  ]);

describe('public expense and commerce composition', () => {
  it('bills the retained cost basis and taxes only explicitly selected lines', () => {
    const expense = purchase();
    const basis = expense.getCostBasis();
    expect(basis?.costBasis).toBe(10700);
    const billing = calculateCostBilling({
      basisMinor: basis!.costBasis,
      mode: 'reimbursement-plus-fee',
      markup: markup(),
    });
    expect(billing).toMatchObject({
      principalMinor: 10700,
      feeMinor: 2140,
      totalMinor: 12840,
      markup: { percent: '20', selectedIndex: 1 },
    });
    const tax = calculateCostBillingTax({
      lines: [
        {
          id: 'principal',
          amountMinor: billing.principalMinor,
          category: 'exempt',
        },
        { id: 'fee', amountMinor: billing.feeMinor, category: 'taxable' },
      ],
      rules: [
        { category: 'exempt', components: [] },
        { category: 'taxable', components: [{ id: 'test-tax', percent: '5' }] },
      ],
      roundingScope: 'invoice',
    });
    expect(tax.taxMinor).toBe(107);
    expect(billing.totalMinor + tax.taxMinor).toBe(12947);
    expect(expense.amount).toBe(11200);
  });

  it('charges only the fee for third-party costs and reverses refunds exactly', () => {
    const expense = purchase();
    expense.paidBy = 'third-party';
    expense.paidByName = 'Synthetic customer';
    const input = {
      basisMinor: expense.getCostBasis()!.costBasis,
      markup: markup(),
    };
    expect(calculateCostBilling({ ...input, mode: 'fee-only' })).toMatchObject({
      principalMinor: 0,
      feeMinor: 2140,
      totalMinor: 2140,
    });
    expect(
      calculateCostBilling({
        ...input,
        basisMinor: purchase(-1).getCostBasis()!.costBasis,
        mode: 'reimbursement-plus-fee',
      }),
    ).toMatchObject({
      principalMinor: -10700,
      feeMinor: -2140,
      totalMinor: -12840,
    });
    for (const mode of ['nonbillable', 'fixed-contract'] as const) {
      expect(calculateCostBilling({ ...input, mode }).totalMinor).toBe(0);
    }
  });

  it('exposes the line-versus-invoice rounding difference explicitly', () => {
    const input = {
      lines: [
        { id: 'a', amountMinor: 10, category: 'fee' },
        { id: 'b', amountMinor: 10, category: 'fee' },
      ],
      rules: [
        { category: 'fee', components: [{ id: 'test-tax', percent: '5' }] },
      ],
    };
    expect(
      calculateCostBillingTax({ ...input, roundingScope: 'line' }).taxMinor,
    ).toBe(2);
    expect(
      calculateCostBillingTax({ ...input, roundingScope: 'invoice' }).taxMinor,
    ).toBe(1);
    expect(() =>
      calculateCostBillingTax({
        ...input,
        rules: [],
        roundingScope: 'invoice',
      }),
    ).toThrow(/Missing explicit/);
  });

  it('does not invent a cost basis for a legacy expense', () => {
    expect(
      new Expense({ amount: 11200, currency: 'CAD' }).getCostBasis(),
    ).toBeNull();
  });
});
