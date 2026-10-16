/** Explicit cash direction, without inferring tax basis or historical payments. */
import {
  ExpenseError,
  type ExpenseRefundRecipient,
  type ExpenseReimbursementPosition,
} from './types.js';

function invalid(message: string): never {
  throw new ExpenseError(
    'EXPENSE_INVALID',
    `Expense reimbursement: ${message}`,
  );
}

export function parseRefundRecipient(
  stored: string | null,
): ExpenseRefundRecipient | null {
  if (stored === null || stored === '') return null;
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return invalid('invalid recipient JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid('recipient must be an object.');
  const object = value as Record<string, unknown>;
  if (object.kind === 'company' && Object.keys(object).length === 1)
    return { kind: 'company' };
  if (
    object.kind === 'person' &&
    Object.keys(object).length === 2 &&
    typeof object.profileId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      object.profileId,
    )
  )
    return { kind: 'person', profileId: object.profileId };
  // Exact retained evidence only: no trimming, lookup or identity inference.
  if (
    object.kind === 'third-party' &&
    Object.keys(object).length === 2 &&
    typeof object.name === 'string' &&
    object.name.trim().length > 0 &&
    object.name.length <= 200
  )
    return { kind: 'third-party', name: object.name };
  return invalid(
    'recipient must explicitly identify company, person profile or a third-party name (1–200 characters).',
  );
}

interface Source {
  id: string;
  currency: string;
  amount: number;
  paidBy: string;
  paidByProfileId: string | null;
  reimbursable: boolean;
  reimbursedAt: Date | null;
  reimbursedAmount: number | null;
}
interface Refund {
  amount: number;
  getRefundRecipient(): ExpenseRefundRecipient | null;
}

export function calculateReimbursementPosition(
  source: Source,
  refunds: Refund[],
): ExpenseReimbursementPosition {
  if (
    !Number.isSafeInteger(source.amount) ||
    source.amount <= 0 ||
    source.paidBy !== 'person' ||
    !source.paidByProfileId ||
    !source.reimbursable
  )
    invalid('requires a positive person-paid reimbursable source.');
  let person = 0n;
  let company = 0n;
  let reason: ExpenseReimbursementPosition['unknownReason'] = null;
  for (const refund of refunds) {
    const recipient = refund.getRefundRecipient();
    if (!recipient) reason ??= 'unknown-refund-recipient';
    else if (recipient.kind === 'company') company -= BigInt(refund.amount);
    else if (recipient.kind === 'third-party')
      reason ??= 'unknown-third-party-recipient';
    else if (recipient.profileId === source.paidByProfileId)
      person -= BigInt(refund.amount);
    else reason ??= 'recipient-is-another-person';
  }
  if (
    source.reimbursedAmount !== null &&
    (!source.reimbursedAt ||
      !Number.isSafeInteger(source.reimbursedAmount) ||
      source.reimbursedAmount <= 0 ||
      source.reimbursedAmount > source.amount)
  ) {
    invalid('retained paid amount is inconsistent with original gross claim.');
  }
  const paid = source.reimbursedAt ? source.reimbursedAmount : 0;
  if (paid === null) reason = 'legacy-reimbursement-amount';
  const net =
    reason || paid === null
      ? null
      : BigInt(source.amount) - person - BigInt(paid);
  const safe = (amount: bigint): number => {
    const value = Number(amount);
    if (!Number.isSafeInteger(value)) invalid('unsafe cash position.');
    return value;
  };
  return {
    sourceId: source.id,
    currency: source.currency,
    sourceAmount: source.amount,
    personRefundAmount: reason ? null : safe(person),
    companyRefundAmount: reason ? null : safe(company),
    reimbursedAmount: paid,
    remainingAmount: net === null ? null : safe(net > 0n ? net : 0n),
    owedToCompany: net === null ? null : safe(net < 0n ? -net : 0n),
    unknownReason: reason,
  };
}
