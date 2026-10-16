/**
 * ExpenseCollection — queries, per-currency totals, and commitment drawdown.
 *
 * @packageDocumentation
 */

import {
  ContractLineItemCollection,
  PurchaseContractCollection,
} from '@happyvertical/smrt-commerce';
import { method, SmrtCollection, smrt } from '@happyvertical/smrt-core';
import type {
  AttachExpenseReceiptActionInput,
  MarkExpenseReimbursedActionInput,
  RecordExpenseActionInput,
  ReviewExpenseActionInput,
} from '../actions/expense-actions.js';
import { Expense } from '../models/Expense.js';
import type { ExpenseReceipt } from '../models/ExpenseReceipt.js';
import {
  type CommitmentPosition,
  type CurrencyTotals,
  ExpenseError,
  type ExpenseFinancialBreakdown,
  type ExpenseRefundPosition,
  type ExpenseReviewStatus,
  type ExpenseTotalsOptions,
} from '../types.js';

/** A reviewed, non-duplicate expense and its optional stored supplier facts. */
export interface ReviewedExpenseTaxFact {
  /** Legacy owner identity alias retained for existing callers. */
  id: string;
  /** Reporting identity consumed by commerce tax-summary facts. */
  expenseId: string;
  tenantId: string;
  incurredOn: string;
  currency: string;
  commitmentId: string | null;
  commitmentLineId: string | null;
  /** `null` is unknown legacy supplier tax, never an implied zero. */
  financialBreakdown: ExpenseFinancialBreakdown | null;
}

export interface ReviewedExpenseTaxFactsOptions {
  tenantId: string;
  from: string;
  to: string;
  currency?: string;
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

/** Plain projection read for sums: never hydrates objects. */
interface AmountRow {
  id: string;
  amount: number | string;
  currency: string;
  reviewStatus: ExpenseReviewStatus;
  duplicateOfId: string | null;
}

const AMOUNT_FIELDS = [
  'id',
  'amount',
  'currency',
  'reviewStatus',
  'duplicateOfId',
] as const;

function toMinorUnits(value: number | string): number {
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(amount)) {
    throw new ExpenseError(
      'EXPENSE_INVALID',
      `Stored expense amount ${String(value)} is not a safe integer.`,
    );
  }
  return amount;
}

function addTo(totals: CurrencyTotals, currency: string, amount: number) {
  const entry = totals[currency] ?? { amount: 0, count: 0 };
  const sum = entry.amount + amount;
  if (!Number.isSafeInteger(sum)) {
    throw new ExpenseError(
      'EXPENSE_INVALID',
      `Total for ${currency} exceeds the safe integer range.`,
    );
  }
  totals[currency] = { amount: sum, count: entry.count + 1 };
}

/**
 * Collection for {@link Expense}. Reads go through the normal tenant
 * interceptors, so inside `withTenant()` every method here sees only that
 * tenant's expenses.
 *
 * Collection classes are registered too, so this one carries its own
 * surface; without it every public method here would become an MCP tool. It
 * publishes only the service-backed write actions (#4001), on REST: each
 * authorizes the signed-in person itself (`expenses.<action>`) and delegates
 * to the guarded domain flow. Reads, MCP and CLI stay closed.
 */
@smrt({
  api: {
    include: ['record', 'attachReceipt', 'recordReview', 'recordReimbursement'],
  },
  mcp: { include: [] },
  cli: false,
})
export class ExpenseCollection extends SmrtCollection<Expense> {
  static readonly _itemClass = Expense;

  /** All persisted linked refunds reserve source capacity, irrespective of review. */
  async refundPosition(sourceId: string): Promise<ExpenseRefundPosition> {
    const source = await this.get({ id: sourceId }, { cache: false });
    if (!source)
      throw new ExpenseError('EXPENSE_INVALID', 'Refund source was not found.');
    return source.getRefundPosition();
  }

  /**
   * Record a new, unreviewed expense for the signed-in person in their
   * tenant. Needs `expenses.record`; a person-paid expense for someone else
   * also needs `expenses.recordReview`.
   */
  @method({
    httpMethod: 'POST',
    path: 'record',
    effect: 'write',
    idempotent: false,
    openWorld: false,
    description: 'Record a new expense for review (service-backed).',
  })
  async record(options: RecordExpenseActionInput): Promise<Expense> {
    const { recordExpenseAction } = await import(
      '../actions/expense-actions.js'
    );
    return recordExpenseAction(this, options);
  }

  /**
   * Attach a stored asset to an expense as its receipt. Needs
   * `expenses.attachReceipt`; only the recorder or payer may attach unless
   * the caller holds `expenses.recordReview`.
   */
  @method({
    httpMethod: 'POST',
    path: 'attachReceipt',
    effect: 'write',
    idempotent: false,
    openWorld: false,
    description: 'Attach a receipt file to an expense (service-backed).',
  })
  async attachReceipt(
    options: AttachExpenseReceiptActionInput,
  ): Promise<ExpenseReceipt> {
    const { attachExpenseReceiptAction } = await import(
      '../actions/expense-actions.js'
    );
    return attachExpenseReceiptAction(this, options);
  }

  /**
   * Accept or refuse (with a reason) an expense, attributed to the signed-in
   * reviewer. Needs an explicit `expenses.recordReview` grant.
   */
  @method({
    httpMethod: 'POST',
    path: 'recordReview',
    effect: 'write',
    idempotent: false,
    openWorld: false,
    description: 'Approve or reject an expense with a reason (service-backed).',
  })
  async recordReview(options: ReviewExpenseActionInput): Promise<Expense> {
    const { reviewExpenseAction } = await import(
      '../actions/expense-actions.js'
    );
    return reviewExpenseAction(this, options);
  }

  /**
   * Record that the person who paid an expense has been paid back. Needs an
   * explicit `expenses.recordReimbursement` grant.
   */
  @method({
    httpMethod: 'POST',
    path: 'recordReimbursement',
    effect: 'write',
    idempotent: false,
    openWorld: false,
    description: 'Record that an expense was reimbursed (service-backed).',
  })
  async recordReimbursement(
    options: MarkExpenseReimbursedActionInput,
  ): Promise<Expense> {
    const { markExpenseReimbursedAction } = await import(
      '../actions/expense-actions.js'
    );
    return markExpenseReimbursedAction(this, options);
  }

  /**
   * Expenses charged to one cost object, oldest incurred first.
   *
   * @param costObjectType - Qualified class name of the cost object.
   * @param costObjectId - Id of the cost object.
   */
  async forCostObject(
    costObjectType: string,
    costObjectId: string,
  ): Promise<Expense[]> {
    return this.list({
      where: { costObjectType, costObjectId },
      orderBy: ['incurred_on ASC', 'created_at ASC'],
    });
  }

  /**
   * Sum expenses per currency. Amounts in different currencies are never
   * added together: the result is keyed by ISO 4217 code.
   *
   * By default only `reviewed` expenses count; a duplicate never counts.
   *
   * @example
   * ```typescript
   * const totals = await expenses.totalsByCurrency({
   *   where: { costObjectType: JOB, costObjectId: job.id },
   * });
   * // { USD: { amount: 125000, count: 3 }, CAD: { amount: 4000, count: 1 } }
   * ```
   */
  async totalsByCurrency(
    options: ExpenseTotalsOptions = {},
  ): Promise<CurrencyTotals> {
    const statuses = options.reviewStatuses ?? ['reviewed'];
    if (statuses.length === 0) return {};
    const rows = (await this.list({
      where: {
        ...(options.where ?? {}),
        reviewStatus: [...statuses],
        duplicateOfId: null,
      },
      select: [...AMOUNT_FIELDS],
    })) as unknown as AmountRow[];

    const totals: CurrencyTotals = {};
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      addTo(totals, row.currency, toMinorUnits(row.amount));
    }
    return totals;
  }

  /**
   * Stored supplier-tax facts for reporting. Only reviewed non-duplicate
   * expenses are returned; callers must retain a null breakdown as unknown.
   */
  async listReviewedTaxFacts(
    options: ReviewedExpenseTaxFactsOptions,
  ): Promise<ReviewedExpenseTaxFact[]> {
    if (
      !options.tenantId?.trim() ||
      !isCalendarDate(options.from) ||
      !isCalendarDate(options.to) ||
      options.from > options.to ||
      (options.currency !== undefined && !options.currency.trim())
    ) {
      throw new ExpenseError(
        'EXPENSE_INVALID',
        'Tax facts require a tenant, an ordered calendar-date range, and a nonempty currency when supplied.',
      );
    }
    const expenses = await this.list({
      where: {
        tenantId: options.tenantId,
        reviewStatus: 'reviewed',
        duplicateOfId: null,
        'incurredOn >=': options.from,
        'incurredOn <=': options.to,
        ...(options.currency ? { currency: options.currency } : {}),
      },
      orderBy: ['incurred_on ASC', 'id ASC'],
    });
    return expenses.map((expense) => {
      if (!expense.id || expense.tenantId !== options.tenantId) {
        throw new ExpenseError(
          'EXPENSE_INVALID',
          'Tenant tax-fact query returned a row without its requested tenant identity.',
        );
      }
      return {
        id: expense.id,
        expenseId: expense.id,
        tenantId: expense.tenantId,
        incurredOn: expense.incurredOn,
        currency: expense.currency,
        commitmentId: expense.commitmentId,
        commitmentLineId: expense.commitmentLineId,
        financialBreakdown: expense.getFinancialBreakdown(),
      };
    });
  }

  /**
   * What remains open on a commitment — a commerce `Contract`, normally a
   * `PurchaseOrder` — or on one of its lines.
   *
   * `committed` is the contract's `totalAmount` (or the line's `amount`);
   * `drawn` sums the matched actuals that are `reviewed` and not marked
   * duplicate, in the commitment's currency, each expense once. Unreviewed,
   * rejected and duplicate matches are counted in `excluded` and never
   * drawn. A 4,600 commitment with 1,000 reviewed leaves 3,600 open.
   *
   * @param commitmentId - The commitment's contract id.
   * @param options.lineId - Restrict to one line of the commitment.
   * @throws {ExpenseError} `EXPENSE_COMMITMENT_MISMATCH` when the commitment
   *   (or line) is not visible in the current tenant.
   */
  async commitmentPosition(
    commitmentId: string,
    options: { lineId?: string } = {},
  ): Promise<CommitmentPosition> {
    const contracts = await PurchaseContractCollection.create({ db: this.db });
    const commitment = await contracts.get({ id: commitmentId });
    if (!commitment) {
      throw new ExpenseError(
        'EXPENSE_COMMITMENT_MISMATCH',
        `Commitment ${commitmentId} was not found.`,
      );
    }
    let committed = toMinorUnits(commitment.totalAmount);
    if (options.lineId) {
      const lines = await ContractLineItemCollection.create({ db: this.db });
      const line = await lines.get({ id: options.lineId });
      if (!line || line.contractId !== commitmentId) {
        throw new ExpenseError(
          'EXPENSE_COMMITMENT_MISMATCH',
          `Line ${options.lineId} is not a line of commitment ${commitmentId}.`,
        );
      }
      committed = toMinorUnits(line.amount);
    }
    const currency = String(commitment.currency).toUpperCase();

    const rows = (await this.list({
      where: {
        commitmentId,
        ...(options.lineId ? { commitmentLineId: options.lineId } : {}),
      },
      select: [...AMOUNT_FIELDS],
    })) as unknown as AmountRow[];

    const position: CommitmentPosition = {
      commitmentId,
      commitmentLineId: options.lineId ?? null,
      currency,
      committed,
      drawn: 0,
      open: 0,
      overrun: 0,
      countedExpenseIds: [],
      excluded: { unreviewed: 0, rejected: 0, duplicate: 0 },
      otherCurrencies: {},
    };
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      if (row.duplicateOfId) {
        position.excluded.duplicate += 1;
      } else if (row.reviewStatus === 'unreviewed') {
        position.excluded.unreviewed += 1;
      } else if (row.reviewStatus === 'rejected') {
        position.excluded.rejected += 1;
      } else if (row.currency !== currency) {
        addTo(position.otherCurrencies, row.currency, toMinorUnits(row.amount));
      } else {
        const drawn = position.drawn + toMinorUnits(row.amount);
        if (!Number.isSafeInteger(drawn)) {
          throw new ExpenseError(
            'EXPENSE_INVALID',
            `Drawdown on commitment ${commitmentId} exceeds the safe range.`,
          );
        }
        position.drawn = drawn;
        position.countedExpenseIds.push(row.id);
      }
    }
    position.countedExpenseIds.sort();
    position.open = Math.max(committed - position.drawn, 0);
    position.overrun = Math.max(position.drawn - committed, 0);
    return position;
  }
}
