/**
 * Shared vocabulary, option shapes, and errors for smrt-expenses.
 *
 * @packageDocumentation
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import type { ExpenseReceipt } from './models/ExpenseReceipt.js';

/**
 * Review state of an expense. Only `reviewed` expenses count toward a
 * commitment's drawdown or a cost roll-up of reviewed actuals.
 *
 * - `unreviewed` — recorded, not yet looked at (every expense starts here).
 * - `reviewed` — a reviewer accepted it as a real cost.
 * - `rejected` — a reviewer refused it (including as a duplicate).
 */
export type ExpenseReviewStatus = 'unreviewed' | 'reviewed' | 'rejected';

/** Every {@link ExpenseReviewStatus}, in lifecycle order. */
export const EXPENSE_REVIEW_STATUSES: readonly ExpenseReviewStatus[] =
  Object.freeze(['unreviewed', 'reviewed', 'rejected']);

/**
 * Who paid for an expense: the `company` (card, account, vendor terms) or a
 * named `person` out of pocket, who may then be owed a reimbursement.
 */
export type ExpensePayer = 'company' | 'person';

/** Every {@link ExpensePayer}. */
export const EXPENSE_PAYERS: readonly ExpensePayer[] = Object.freeze([
  'company',
  'person',
]);

/**
 * Suggested expense categories. `Expense.category` is an open string so a
 * vertical can add its own; these cover teamworks-os `JobExpense`
 * (`material | consumable | outside-service | freight | other`) plus the
 * common additions `equipment` and `travel`.
 */
export const SUGGESTED_EXPENSE_CATEGORIES: readonly string[] = Object.freeze([
  'material',
  'consumable',
  'outside-service',
  'freight',
  'equipment',
  'travel',
  'other',
]);

/** Constructor options for {@link Expense}. */
export interface ExpenseOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  costObjectType?: string;
  costObjectId?: string;
  category?: string;
  description?: string;
  amount?: number;
  currency?: string;
  incurredOn?: string;
  recordedAt?: Date | null;
  recordedByProfileId?: string | null;
  paidBy?: ExpensePayer;
  paidByProfileId?: string | null;
  vendorId?: string | null;
  commitmentId?: string | null;
  commitmentLineId?: string | null;
  reimbursable?: boolean;
  reimbursedAt?: Date | null;
  reimbursementReference?: string;
}

/** Constructor options for {@link ExpenseReceipt}. */
export interface ExpenseReceiptOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  expenseId?: string;
  assetId?: string;
  uploadedByProfileId?: string | null;
  filename?: string;
  mimeType?: string;
  byteCount?: number;
  contentSha256?: string;
}

/** Arguments for `Expense.review()`. */
export interface ReviewExpenseInput {
  /** Profile id of the reviewer. Required: a review is always attributed. */
  reviewerProfileId: string;
  /** Optional note kept on the expense. */
  note?: string;
  /** Review time; defaults to now. */
  at?: Date;
}

/** Arguments for `Expense.reject()`. */
export interface RejectExpenseInput {
  /** Profile id of the reviewer. */
  reviewerProfileId: string;
  /** Why the expense was refused. Required. */
  reason: string;
  /** Review time; defaults to now. */
  at?: Date;
}

/** Arguments for `Expense.markDuplicate()`. */
export interface MarkDuplicateExpenseInput {
  /** Profile id of the reviewer. */
  reviewerProfileId: string;
  /** Id of the expense this one duplicates (same tenant, not itself). */
  duplicateOfId: string;
  /** Review time; defaults to now. */
  at?: Date;
}

/** Arguments for `Expense.reopen()`. */
export interface ReopenExpenseInput {
  /** Profile id of the person reopening the review. */
  reviewerProfileId: string;
  /** Optional note kept on the expense. */
  note?: string;
}

/** Arguments for `Expense.markReimbursed()`. */
export interface MarkReimbursedInput {
  /** When the person was paid back; defaults to now. */
  at?: Date;
  /** Payroll line, payables reference, or transfer id. */
  reference?: string;
}

/** Arguments for `ExpenseReceiptCollection.attachReceipt()`. */
export interface AttachReceiptInput {
  /** The expense the receipt proves. */
  expenseId: string;
  /** The smrt-assets `Asset` holding the file. */
  assetId: string;
  /** Lowercase hex SHA-256 of the file's bytes (see `computeContentSha256`). */
  contentSha256: string;
  /** Who uploaded the file. */
  uploadedByProfileId?: string | null;
  /** Original filename; defaults to the asset's name. */
  filename?: string;
  /** MIME type; defaults to the asset's MIME type. */
  mimeType?: string;
  /** Size of the file in bytes. */
  byteCount?: number;
}

/** Per-currency total. Amounts are integer minor units. */
export interface CurrencyTotal {
  /** Sum of `amount` in integer minor units. */
  amount: number;
  /** Number of expenses in the sum. */
  count: number;
}

/**
 * Totals keyed by ISO 4217 currency code. Amounts in different currencies
 * are never added together.
 */
export type CurrencyTotals = Record<string, CurrencyTotal>;

/** Options for `ExpenseCollection.totalsByCurrency()`. */
export interface ExpenseTotalsOptions {
  /** Extra SMRT `where` filters (cost object, category, date range...). */
  where?: Record<string, unknown>;
  /**
   * Review states to include. Defaults to `['reviewed']`; expenses marked as
   * a duplicate are never included.
   */
  reviewStatuses?: readonly ExpenseReviewStatus[];
}

/** Open position of a commitment (or one of its lines). */
export interface CommitmentPosition {
  /** The commerce `Contract` (usually a `PurchaseOrder`) drawn down. */
  commitmentId: string;
  /** The line drawn down, when the position is for one line. */
  commitmentLineId: string | null;
  /** The commitment's currency; the only currency that draws it down. */
  currency: string;
  /** Committed amount: the contract's `totalAmount`, or the line's `amount`. */
  committed: number;
  /** Sum of reviewed, non-duplicate actuals in the commitment's currency. */
  drawn: number;
  /** `committed - drawn`, never below zero. */
  open: number;
  /** `drawn - committed` when actuals exceed the commitment, else zero. */
  overrun: number;
  /** Ids of the expenses counted in `drawn`, each exactly once. */
  countedExpenseIds: string[];
  /** Matched expenses not counted, by reason. */
  excluded: {
    unreviewed: number;
    rejected: number;
    duplicate: number;
  };
  /**
   * Reviewed actuals matched to this commitment in another currency. Shown,
   * never summed into `drawn` (expenses refuse a mismatched match on save, so
   * this only fills when a commitment's currency changes after matching).
   */
  otherCurrencies: CurrencyTotals;
}

/** A content hash attached to more than one expense. */
export interface DuplicateReceiptGroup {
  /** The shared SHA-256. */
  contentSha256: string;
  /** Distinct expenses carrying the file, sorted. */
  expenseIds: string[];
  /** Every receipt row carrying the file. */
  receipts: ExpenseReceipt[];
}

/** Options for `ExpenseReceiptCollection.findDuplicateReceipts()`. */
export interface FindDuplicateReceiptsOptions {
  /** Only report files that this expense shares with other expenses. */
  expenseId?: string;
  /** Maximum number of groups to return (default 100, at most 1,000). */
  limit?: number;
}

/** Stable error codes raised by this package. */
export type ExpenseErrorCode =
  | 'EXPENSE_INVALID'
  | 'EXPENSE_REVIEW_TRANSITION'
  | 'EXPENSE_REVIEW_FIELDS_LOCKED'
  | 'EXPENSE_COMMITMENT_MISMATCH'
  | 'EXPENSE_RECEIPT_INVALID'
  | 'EXPENSE_RECEIPT_DUPLICATE'
  | 'EXPENSE_IDENTITY_CONFLICT'
  | 'EXPENSE_VENDOR_MISMATCH';

/**
 * Base error for this package. `code` is stable and safe to branch on.
 */
export class ExpenseError extends Error {
  readonly code: ExpenseErrorCode;

  constructor(code: ExpenseErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ExpenseError';
    this.code = code;
  }
}

/**
 * Raised when the same file (same SHA-256) is attached to one expense twice.
 * The same file on two different expenses is allowed and reported by
 * `findDuplicateReceipts()` instead.
 */
export class DuplicateReceiptError extends ExpenseError {
  readonly expenseId: string;
  readonly contentSha256: string;

  constructor(
    expenseId: string,
    contentSha256: string,
    options?: ErrorOptions,
  ) {
    super(
      'EXPENSE_RECEIPT_DUPLICATE',
      `Expense ${expenseId} already has a receipt with SHA-256 ` +
        `${contentSha256}; the same file cannot be attached twice.`,
      options,
    );
    this.name = 'DuplicateReceiptError';
    this.expenseId = expenseId;
    this.contentSha256 = contentSha256;
  }
}
