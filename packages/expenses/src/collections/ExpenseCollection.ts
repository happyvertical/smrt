/**
 * ExpenseCollection — queries, per-currency totals, and commitment drawdown.
 *
 * @packageDocumentation
 */

import {
  ContractCollection,
  ContractLineItemCollection,
} from '@happyvertical/smrt-commerce';
import { SmrtCollection, smrt } from '@happyvertical/smrt-core';
import { Expense } from '../models/Expense.js';
import {
  type CommitmentPosition,
  type CurrencyTotals,
  ExpenseError,
  type ExpenseReviewStatus,
  type ExpenseTotalsOptions,
} from '../types.js';

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
 * Collection classes are registered too, so this one carries its own closed
 * surface; without it every public method here would become an MCP tool.
 */
@smrt({ api: { include: [] }, mcp: { include: [] }, cli: false })
export class ExpenseCollection extends SmrtCollection<Expense> {
  static readonly _itemClass = Expense;

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
    const contracts = await ContractCollection.create({ db: this.db });
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
