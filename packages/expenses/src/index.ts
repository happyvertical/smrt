/**
 * @happyvertical/smrt-expenses
 *
 * Expense records for the SMRT framework: a reviewed cost against a cost
 * object (job, work package, project), a deduplicated receipt link to
 * smrt-assets, reimbursement recording, and drawdown of smrt-commerce
 * commitments.
 *
 * @example
 * ```typescript
 * import {
 *   ExpenseCollection,
 *   ExpenseReceiptCollection,
 *   computeContentSha256,
 * } from '@happyvertical/smrt-expenses';
 *
 * const expenses = await ExpenseCollection.create({ db });
 * const expense = await expenses.create({
 *   costObjectType: '@happyvertical/smrt-projects:Project',
 *   costObjectId: project.id,
 *   category: 'material',
 *   amount: 12500, // $125.00 in cents
 *   currency: 'USD',
 *   incurredOn: '2026-09-30',
 *   recordedByProfileId: me.id,
 * });
 * await expense.save();
 *
 * const receipts = await ExpenseReceiptCollection.create({ db });
 * await receipts.attachReceipt({
 *   expenseId: expense.id,
 *   assetId: asset.id,
 *   contentSha256: computeContentSha256(bytes),
 * });
 *
 * await expense.review({ reviewerProfileId: manager.id });
 * ```
 *
 * @packageDocumentation
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below. See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__.js';

export { ExpenseCollection } from './collections/ExpenseCollection.js';
export { ExpenseReceiptCollection } from './collections/ExpenseReceiptCollection.js';
export { Expense } from './models/Expense.js';
export { ExpenseReceipt } from './models/ExpenseReceipt.js';
export {
  type AttachReceiptInput,
  type CommitmentPosition,
  type CurrencyTotal,
  type CurrencyTotals,
  DuplicateReceiptError,
  type DuplicateReceiptGroup,
  EXPENSE_PAYERS,
  EXPENSE_REVIEW_STATUSES,
  ExpenseError,
  type ExpenseErrorCode,
  type ExpenseOptions,
  type ExpensePayer,
  type ExpenseReceiptOptions,
  type ExpenseReviewStatus,
  type ExpenseTotalsOptions,
  type FindDuplicateReceiptsOptions,
  type MarkDuplicateExpenseInput,
  type MarkReimbursedInput,
  type RejectExpenseInput,
  type ReopenExpenseInput,
  type ReviewExpenseInput,
  SUGGESTED_EXPENSE_CATEGORIES,
} from './types.js';
export { computeContentSha256 } from './validation.js';
