/**
 * Service-backed write actions for `Expense` and `ExpenseReceipt` (#4001).
 *
 * The generated CRUD surface stays closed: these are the only generated
 * writes, and each delegates to the existing domain flow — `Expense.save()`
 * with its review lock and refund/commitment/vendor guards, the method-only
 * `review()` / `reject()` / `markReimbursed()`, and
 * `ExpenseReceiptCollection.attachReceipt()` with its hash deduplication.
 * The thin `ExpenseCollection` methods call in here.
 */
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import type { ExpenseCollection } from '../collections/ExpenseCollection.js';
import { ExpenseReceiptCollection } from '../collections/ExpenseReceiptCollection.js';
import type { Expense } from '../models/Expense.js';
import type { ExpenseReceipt } from '../models/ExpenseReceipt.js';
import {
  ExpenseError,
  type ExpenseErrorCode,
  type ExpenseFinancialBreakdown,
  type ExpensePayer,
} from '../types.js';
import {
  authorizeExpenseAction,
  ExpenseActionError,
  type ExpenseActionPrincipal,
  principalHolds,
  withActionPrincipal,
} from './principal.js';

/** Body of the `record` action. Tenant and recorder come from the session. */
export interface RecordExpenseActionInput {
  costObjectType?: string;
  costObjectId?: string;
  category?: string;
  description?: string;
  /** Integer minor units of `currency`. */
  amount: number;
  currency: string;
  /** `YYYY-MM-DD`. */
  incurredOn: string;
  paidBy?: ExpensePayer;
  /** Defaults to the signed-in person when `paidBy` is `person`. */
  paidByProfileId?: string | null;
  paidByName?: string | null;
  vendorId?: string | null;
  commitmentId?: string | null;
  commitmentLineId?: string | null;
  refundOfId?: string | null;
  reimbursable?: boolean;
  financialBreakdown?: ExpenseFinancialBreakdown | null;
}

/** Body of the `attachReceipt` action. */
export interface AttachExpenseReceiptActionInput {
  expenseId: string;
  assetId: string;
  contentSha256: string;
  filename?: string;
  mimeType?: string;
  byteCount?: number;
}

/** Body of the `recordReview` action. */
export interface ReviewExpenseActionInput {
  expenseId: string;
  /** `approve` accepts the cost; `reject` refuses it and needs a `reason`. */
  decision: 'approve' | 'reject';
  note?: string;
  reason?: string;
}

/** Body of the `recordReimbursement` action. */
export interface MarkExpenseReimbursedActionInput {
  expenseId: string;
  /** Optional expected full remaining reimbursement in minor units. */
  amount?: number;
  /** Payroll line, payables reference, or transfer id of the payback. */
  reference?: string;
}

/** `record` fields copied onto the new expense; everything else is ignored. */
const RECORD_FIELDS = [
  'costObjectType',
  'costObjectId',
  'category',
  'description',
  'amount',
  'currency',
  'incurredOn',
  'paidByName',
  'vendorId',
  'commitmentId',
  'commitmentLineId',
  'refundOfId',
  'reimbursable',
] as const;

const CONFLICT_CODES = new Set<ExpenseErrorCode>([
  'EXPENSE_REVIEW_TRANSITION',
  'EXPENSE_REVIEW_FIELDS_LOCKED',
  'EXPENSE_IDENTITY_CONFLICT',
  'EXPENSE_RECEIPT_DUPLICATE',
]);

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExpenseActionError(
      400,
      'invalid_request',
      'The action body must be a JSON object.',
    );
  }
  return value as Record<string, unknown>;
}

function optionalString(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ExpenseActionError(
      400,
      'invalid_request',
      `${key} must be a string.`,
    );
  }
  return value;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = optionalString(body, key)?.trim();
  if (!value) {
    throw new ExpenseActionError(400, 'invalid_request', `${key} is required.`);
  }
  return value;
}

/** Domain refusals become 4xx with their stable code; others pass through. */
async function domainCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ExpenseError) {
      throw new ExpenseActionError(
        CONFLICT_CODES.has(error.code) ? 409 : 400,
        error.code,
        error.message,
      );
    }
    throw error;
  }
}

function itemClass(expenses: ExpenseCollection) {
  return (expenses.constructor as unknown as { _itemClass: unknown })
    ._itemClass as typeof Expense;
}

function options(expenses: ExpenseCollection): SmrtClassOptions {
  return expenses.options;
}

async function loadExpense(
  expenses: ExpenseCollection,
  principal: ExpenseActionPrincipal,
  body: Record<string, unknown>,
): Promise<Expense> {
  const expenseId = requiredString(body, 'expenseId');
  const expense = await expenses.get({ id: expenseId });
  // Optional tenancy also admits global (NULL-tenant) rows in a tenant
  // context; a write must land on the principal's own tenant only.
  if (!expense || (expense.tenantId ?? null) !== principal.tenantId) {
    throw new ExpenseActionError(
      404,
      'not_found',
      `Expense ${expenseId} was not found.`,
    );
  }
  return expense;
}

/**
 * `record`: a new `unreviewed` expense, recorded by the signed-in person in
 * their tenant. Review, reimbursement and duplicate fields are never taken
 * from the body. Paying on someone else's behalf needs `expenses.recordReview`.
 */
export async function recordExpenseAction(
  expenses: ExpenseCollection,
  input: unknown,
): Promise<Expense> {
  const body = asRecord(input);
  const principal = await authorizeExpenseAction(
    itemClass(expenses),
    'record',
    options(expenses),
    { allowSuperAdminBypass: true },
  );
  const paidBy = (optionalString(body, 'paidBy') ?? 'company') as ExpensePayer;
  let paidByProfileId: string | null = null;
  if (paidBy === 'person') {
    paidByProfileId =
      optionalString(body, 'paidByProfileId')?.trim() || principal.profileId;
    if (
      paidByProfileId !== principal.profileId &&
      !(await principalHolds(
        itemClass(expenses),
        'recordReview',
        options(expenses),
      ))
    ) {
      throw new ExpenseActionError(
        403,
        'permission_denied',
        "Recording another person's expense needs the recordReview permission.",
      );
    }
  }
  const fields: Record<string, unknown> = {};
  for (const key of RECORD_FIELDS) {
    if (body[key] !== undefined) fields[key] = body[key];
  }
  const breakdown = body.financialBreakdown;
  if (
    breakdown !== undefined &&
    breakdown !== null &&
    (typeof breakdown !== 'object' || Array.isArray(breakdown))
  ) {
    throw new ExpenseActionError(
      400,
      'invalid_request',
      'financialBreakdown must be an object or null.',
    );
  }
  return withActionPrincipal(principal, () =>
    // One create: `collection.create()` saves, and `Expense.save()` validates
    // the facts (`validateShape()` parses them) before its first INSERT, so an
    // invalid breakdown never leaves a half-recorded row behind.
    domainCall(() =>
      expenses.create({
        ...fields,
        ...(breakdown !== undefined
          ? {
              financialBreakdown:
                breakdown === null ? null : JSON.stringify(breakdown),
            }
          : {}),
        tenantId: principal.tenantId,
        paidBy,
        paidByProfileId,
        recordedByProfileId: principal.profileId,
        recordedAt: null,
      }),
    ),
  );
}

/**
 * `attachReceipt`: link a stored asset to an expense as its receipt through
 * `ExpenseReceiptCollection.attachReceipt()`. The uploader is the signed-in
 * person, who must have recorded or paid the expense unless they hold
 * `expenses.recordReview`.
 */
export async function attachExpenseReceiptAction(
  expenses: ExpenseCollection,
  input: unknown,
): Promise<ExpenseReceipt> {
  const body = asRecord(input);
  const principal = await authorizeExpenseAction(
    itemClass(expenses),
    'attachReceipt',
    options(expenses),
    { allowSuperAdminBypass: true },
  );
  return withActionPrincipal(principal, async () => {
    const expense = await loadExpense(expenses, principal, body);
    if (
      expense.recordedByProfileId !== principal.profileId &&
      expense.paidByProfileId !== principal.profileId &&
      !(await principalHolds(
        itemClass(expenses),
        'recordReview',
        options(expenses),
      ))
    ) {
      throw new ExpenseActionError(
        403,
        'permission_denied',
        "Attaching a receipt to another person's expense needs the recordReview permission.",
      );
    }
    const byteCount = body.byteCount;
    if (byteCount !== undefined && typeof byteCount !== 'number') {
      throw new ExpenseActionError(
        400,
        'invalid_request',
        'byteCount must be a number.',
      );
    }
    const receipts = await ExpenseReceiptCollection.create(options(expenses));
    return domainCall(() =>
      receipts.attachReceipt({
        expenseId: expense.id as string,
        assetId: requiredString(body, 'assetId'),
        contentSha256: requiredString(body, 'contentSha256'),
        uploadedByProfileId: principal.profileId,
        ...(optionalString(body, 'filename') !== undefined
          ? { filename: optionalString(body, 'filename') }
          : {}),
        ...(optionalString(body, 'mimeType') !== undefined
          ? { mimeType: optionalString(body, 'mimeType') }
          : {}),
        ...(byteCount !== undefined ? { byteCount: byteCount as number } : {}),
      }),
    );
  });
}

/**
 * `recordReview`: accept (`Expense.review()`) or refuse with a reason
 * (`Expense.reject()`), attributed to the signed-in reviewer. Money: needs an
 * explicit `expenses.recordReview` grant, super-admin bypass does not apply.
 * Named apart from `Expense.review()` so allowlisting the collection action
 * never opens the instance method, which takes the reviewer from its input.
 */
export async function reviewExpenseAction(
  expenses: ExpenseCollection,
  input: unknown,
): Promise<Expense> {
  const body = asRecord(input);
  const principal = await authorizeExpenseAction(
    itemClass(expenses),
    'recordReview',
    options(expenses),
    { allowSuperAdminBypass: false },
  );
  const decision = optionalString(body, 'decision');
  if (decision !== 'approve' && decision !== 'reject') {
    throw new ExpenseActionError(
      400,
      'invalid_request',
      "decision must be 'approve' or 'reject'.",
    );
  }
  return withActionPrincipal(principal, async () => {
    const expense = await loadExpense(expenses, principal, body);
    return domainCall(() =>
      decision === 'approve'
        ? expense.review({
            reviewerProfileId: principal.profileId,
            note: optionalString(body, 'note') ?? '',
          })
        : expense.reject({
            reviewerProfileId: principal.profileId,
            reason: optionalString(body, 'reason') ?? '',
          }),
    );
  });
}

/**
 * `recordReimbursement`: record that the person who paid has been paid back
 * (`Expense.markReimbursed()`); never changes the review state. Money: needs
 * an explicit `expenses.recordReimbursement` grant.
 */
export async function markExpenseReimbursedAction(
  expenses: ExpenseCollection,
  input: unknown,
): Promise<Expense> {
  const body = asRecord(input);
  const principal = await authorizeExpenseAction(
    itemClass(expenses),
    'recordReimbursement',
    options(expenses),
    { allowSuperAdminBypass: false },
  );
  return withActionPrincipal(principal, async () => {
    const expense = await loadExpense(expenses, principal, body);
    const reference = optionalString(body, 'reference');
    const amount = body.amount;
    if (
      amount !== undefined &&
      (typeof amount !== 'number' ||
        !Number.isSafeInteger(amount) ||
        amount <= 0)
    ) {
      throw new ExpenseActionError(
        400,
        'invalid_request',
        'amount must be a positive safe integer.',
      );
    }
    return domainCall(() =>
      expense.markReimbursed({
        ...(reference !== undefined ? { reference } : {}),
        ...(amount !== undefined ? { amount: amount as number } : {}),
      }),
    );
  });
}
