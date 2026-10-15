/**
 * Declared recipes for smrt-expenses (#3590, #3604): user-facing units of
 * functionality an app or agent can pick instead of the whole package.
 * The scanner reads these statics into the `recipes` array of `manifest.json`
 * and `smrt-knowledge.json`; nothing here runs at that point.
 *
 * @packageDocumentation
 */

import { SmrtRecipe } from '@happyvertical/smrt-core';
import { Expense } from './models/Expense.js';
import { ExpenseReceipt } from './models/ExpenseReceipt.js';

/** Expenses: Record what the business spends, with receipts, and review it. */
export class ExpensesRecipe extends SmrtRecipe {
  static id = 'expenses.tracking';
  static help = './tracking.recipe.md';
  static label = 'Expenses';
  static summary =
    'Record what the business spends, with receipts, and review it.';
  static synonyms = ['costs', 'receipts', 'spending', 'reimbursements'];
  static section = {
    id: 'accounting',
    label: 'Accounting',
    icon: 'bank',
    description: 'Your books: accounts, journals and balances.',
  };
  static models = [Expense, ExpenseReceipt];
  static nav = [
    {
      label: 'Expenses',
      model: Expense,
      icon: 'receipt',
      description: 'Costs you have paid, with the receipt and who paid.',
    },
  ];
  static options = {
    Expense: {
      fields: {
        description: { order: 1, required: true },
        amount: { order: 2 },
        currency: { order: 3 },
        incurredOn: {
          label: 'Date',
          order: 4,
          help: 'The date on the receipt, as YYYY-MM-DD.',
        },
        category: {
          order: 5,
          help: 'One word, such as material, travel, freight or other.',
        },
        vendorId: { label: 'Vendor', order: 6 },
        paidBy: { order: 7 },
        paidByName: { order: 8 },
        reimbursable: { order: 9 },
        costObjectId: {
          label: 'Charged to',
          order: 10,
          help: 'The job, project or client the cost belongs to.',
        },
        costObjectType: { visibility: 'hidden' },
        financialBreakdown: { visibility: 'hidden' },
        refundOfId: { visibility: 'hidden' },
        recordedByProfileId: { visibility: 'hidden' },
        paidByProfileId: { visibility: 'hidden' },
        commitmentId: { visibility: 'hidden' },
        commitmentLineId: { visibility: 'hidden' },
        reviewedByProfileId: { visibility: 'hidden' },
        duplicateOfId: { visibility: 'hidden' },
      },
    },
    ExpenseReceipt: {
      fields: {
        contentSha256: { visibility: 'hidden' },
        byteCount: { visibility: 'hidden' },
        uploadedByProfileId: { visibility: 'hidden' },
      },
    },
  } as const;
}
