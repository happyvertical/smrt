/** Exact source-preserving reversal bounds; no financial policy is inferred. */
import { expenseCostBasis } from './financial-facts.js';
import {
  ExpenseError,
  type ExpenseFinancialBreakdown,
  type ExpenseRefundPosition,
} from './types.js';

interface RefundFact {
  id: string;
  amount: number;
  currency: string;
  getFinancialBreakdown(): ExpenseFinancialBreakdown | null;
}

function invalid(message: string): never {
  throw new ExpenseError('EXPENSE_INVALID', `Expense refund: ${message}`);
}

function safe(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) invalid('unsafe calculated amount.');
  return result;
}

/** Validate known reversals even when other financial facts remain unknown. */
export function calculateRefundPosition(
  source: RefundFact,
  refunds: RefundFact[],
): ExpenseRefundPosition {
  if (!Number.isSafeInteger(source.amount) || source.amount <= 0) {
    invalid('source must remain positive.');
  }
  const sourceFacts = source.getFinancialBreakdown();
  let refunded = 0n;
  let subtotal = 0n;
  let complete = sourceFacts !== null;
  const components = new Map(
    sourceFacts?.taxes.map((tax) => [tax.code, { charged: 0n, recovered: 0n }]),
  );
  const ids = new Set<string>();
  for (const refund of refunds) {
    if (ids.has(refund.id)) invalid('duplicate refund identity.');
    ids.add(refund.id);
    if (
      !Number.isSafeInteger(refund.amount) ||
      refund.amount >= 0 ||
      refund.currency !== source.currency
    )
      invalid('linked refunds must be negative and share source currency.');
    refunded -= BigInt(refund.amount);
    const facts = refund.getFinancialBreakdown();
    if (!facts) {
      complete = false;
      continue;
    }
    // Model getters validate facts; keep the pure boundary safe for all callers.
    expenseCostBasis(facts, refund.amount, source.currency);
    if (!sourceFacts) continue;
    subtotal -= BigInt(facts.subtotal);
    for (const tax of facts.taxes) {
      const sum = components.get(tax.code);
      if (!sum)
        invalid(
          `tax component ${tax.code} does not identify a source component.`,
        );
      sum.charged -= BigInt(tax.amount);
      sum.recovered -= BigInt(tax.recoverableAmount);
    }
  }
  if (refunded > BigInt(source.amount))
    invalid('cumulative cash exceeds source gross.');
  if (sourceFacts) {
    expenseCostBasis(sourceFacts, source.amount, source.currency);
    if (subtotal > BigInt(sourceFacts.subtotal))
      invalid('subtotal reversal exceeds source subtotal.');
    for (const tax of sourceFacts.taxes) {
      const sum = components.get(tax.code);
      if (!sum) invalid('missing source component.');
      if (
        sum.charged > BigInt(tax.amount) ||
        sum.recovered > BigInt(tax.recoverableAmount) ||
        sum.charged - sum.recovered > BigInt(tax.amount - tax.recoverableAmount)
      )
        invalid(
          `tax component ${tax.code} reversal exceeds its source component.`,
        );
    }
  }
  const position: ExpenseRefundPosition = {
    sourceId: source.id,
    currency: source.currency,
    sourceAmount: source.amount,
    refundedAmount: safe(refunded),
    remainingAmount: safe(BigInt(source.amount) - refunded),
    refundIds: [...ids].sort(),
    financialPosition: null,
  };
  if (complete && sourceFacts) {
    const reversal: ExpenseFinancialBreakdown = {
      currency: source.currency,
      subtotal: safe(-subtotal),
      taxes: sourceFacts.taxes.map((tax) => {
        const sum = components.get(tax.code);
        if (!sum) invalid('missing source component.');
        return {
          code: tax.code,
          amount: safe(-sum.charged),
          recoverableAmount: safe(-sum.recovered),
        };
      }),
      total: safe(-refunded),
    };
    const remaining: ExpenseFinancialBreakdown = {
      currency: source.currency,
      subtotal: safe(BigInt(sourceFacts.subtotal) - subtotal),
      taxes: sourceFacts.taxes.map((tax, index) => ({
        code: tax.code,
        amount: tax.amount + reversal.taxes[index].amount,
        recoverableAmount:
          tax.recoverableAmount + reversal.taxes[index].recoverableAmount,
      })),
      total: position.remainingAmount,
    };
    expenseCostBasis(remaining, remaining.total, source.currency);
    position.financialPosition = {
      source: sourceFacts,
      refunded: reversal,
      remaining,
    };
  }
  return position;
}
