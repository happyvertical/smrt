/** Expense-owned supplier obligation evidence. No bank, provider or journal execution. */
import { createHash, randomUUID } from 'node:crypto';
import { ExpenseError } from './types.js';
import { assertIsoDate } from './validation.js';

/** Exact source identity and original author; author need not be a current user. */
export interface SupplierPayableSource {
  namespace: string;
  key: string;
  version: string;
  author: string | null;
}
/** Caller-reviewed evidence, independently attributed from original source authors. */
export interface SupplierPayableReview {
  recordedByProfileId: string;
  evidenceRef: string;
}
/** Dated ordering is explicit, including multiple events on one calendar day. */
export type SupplierPayableEventInput = {
  effectiveOn: string;
  sequence: number;
  evidenceRef: string;
  source?: SupplierPayableSource;
} & (
  | { kind: 'hold' | 'release' | 'settlement'; amountMinor: number }
  | {
      kind: 'refund';
      refundExpenseId: string;
      payableReductionMinor: number;
      retainedReductionMinor: number;
      cashReturnedMinor: number;
    }
);
/** Immutable original supplier payable snapshot; null basis is explicitly unknown. */
export interface RecordSupplierPayableInput extends SupplierPayableReview {
  requestId: string;
  currency: string;
  source: SupplierPayableSource;
  payableBasisMinor: number | null;
  events: SupplierPayableEventInput[];
}
/** Append an evidenced current event. This records facts and never executes a payment. */
export interface RecordSupplierPayableEventInput extends SupplierPayableReview {
  requestId: string;
  currency: string;
  event: SupplierPayableEventInput;
}
/** Complete unknown original basis once, preserving the original snapshot. */
export interface CompleteSupplierPayableBasisInput
  extends SupplierPayableReview {
  requestId: string;
  currency: string;
  payableBasisMinor: number;
}
/** Concrete immutable child identity retained by the owning Expense command. */
export type SupplierPayableEvent = SupplierPayableEventInput & {
  id: string;
  authority: 'original' | 'current';
  requestId: string;
  requestFingerprint: string;
  recordedByProfileId: string;
  recordedAt: string;
  refundFingerprint?: string;
};
/** Original and subsequent authority remain separate in public readback. */
export interface SupplierPayableState {
  version: 1;
  expenseId: string;
  currency: string;
  expenseFingerprint: string;
  original: SupplierPayableReview & {
    id: string;
    requestId: string;
    requestFingerprint: string;
    source: SupplierPayableSource;
    payableBasisMinor: number | null;
    recordedAt: string;
  };
  completion:
    | (CompleteSupplierPayableBasisInput & {
        id: string;
        requestFingerprint: string;
        recordedAt: string;
      })
    | null;
  events: SupplierPayableEvent[];
}
/** Position is separate from incurred expense, tax recovery and employee reimbursement. */
export interface SupplierPayablePosition {
  expenseId: string;
  currency: string;
  asOfDate: string | null;
  payableBasisMinor: number | null;
  heldMinor: number;
  releasedMinor: number;
  retainedReductionMinor: number;
  /** Recorded holds less recorded releases/reductions, before unresolved interpretation. */
  recordedRetainedMinor: number;
  retainedMinor: number | null;
  settledMinor: number;
  cashReturnedMinor: number;
  netPaidMinor: number | null;
  payableReductionMinor: number;
  remainingPayableMinor: number | null;
  unknownReasons: Array<
    'payable-basis-unknown' | 'refund-interpretation-required'
  >;
  unresolvedRefundExpenseIds: string[];
  authority: SupplierPayableState;
}
/** Owning model projection, not an alternative persistence API. */
export interface PayableExpense {
  id?: string | null;
  tenantId: string | null;
  amount: number;
  currency: string;
  incurredOn: string;
  refundOfId: string | null;
  financialBreakdown: string | null;
  refundRecipient: string | null;
  vendorId: string | null;
  costObjectType: string;
  costObjectId: string;
  paidBy: string;
  paidByProfileId: string | null;
  paidByName: string | null;
}
export function payableInvalid(message: string): never {
  throw new ExpenseError('EXPENSE_INVALID', `Supplier payable: ${message}`);
}
function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000)
    payableInvalid(`${label} must be explicit bounded evidence.`);
}
function minor(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    payableInvalid('amounts must be nonnegative safe minor units.');
}
function source(value: SupplierPayableSource) {
  if (!value || typeof value !== 'object')
    payableInvalid('original source is required.');
  for (const key of ['namespace', 'key', 'version'] as const)
    text(value[key], key);
  if (value.author !== null) text(value.author, 'original author');
}
function review(
  value: SupplierPayableReview & { requestId: string; currency: string },
  expense: PayableExpense,
) {
  text(value.requestId, 'requestId');
  text(value.evidenceRef, 'review evidence');
  if (
    !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
      value.recordedByProfileId,
    )
  )
    payableInvalid('current recorder must be an explicit profile UUID.');
  if (value.currency !== expense.currency)
    payableInvalid('currency must equal the Expense currency.');
}
/** Stable canonical request identity; rejects non-JSON evidence rather than dropping it. */
export function payableDigest(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean')
      return JSON.stringify(item);
    if (typeof item === 'number' && Number.isSafeInteger(item))
      return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    if (
      item &&
      typeof item === 'object' &&
      Object.getPrototypeOf(item) === Object.prototype
    )
      return `{${Object.keys(item)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${canonical((item as Record<string, unknown>)[key])}`,
        )
        .join(',')}}`;
    return payableInvalid('evidence must be exact JSON values.');
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function payableExpenseFingerprint(expense: PayableExpense): string {
  return payableDigest({
    id: expense.id,
    tenantId: expense.tenantId,
    amount: expense.amount,
    currency: expense.currency,
    incurredOn: expense.incurredOn,
    refundOfId: expense.refundOfId,
    financialBreakdown: expense.financialBreakdown,
    refundRecipient: expense.refundRecipient,
    vendorId: expense.vendorId,
    costObjectType: expense.costObjectType,
    costObjectId: expense.costObjectId,
    paidBy: expense.paidBy,
    paidByProfileId: expense.paidByProfileId,
    paidByName: expense.paidByName,
  });
}
export function parseSupplierPayable(
  stored: string | null,
): SupplierPayableState | null {
  if (stored === null || stored === '') return null;
  let value: SupplierPayableState;
  try {
    value = JSON.parse(stored);
  } catch {
    return payableInvalid('invalid retained JSON.');
  }
  if (
    !value ||
    value.version !== 1 ||
    !value.original ||
    !Array.isArray(value.events) ||
    !value.expenseId ||
    !value.expenseFingerprint
  )
    payableInvalid('invalid retained authority.');
  return value;
}
function validateEvent(
  event: SupplierPayableEventInput,
  expense: PayableExpense,
  original: boolean,
) {
  if (!event || typeof event !== 'object') payableInvalid('event is required.');
  assertIsoDate(
    'Expense',
    String(expense.id),
    'supplier payable event date',
    event.effectiveOn,
  );
  if (event.effectiveOn < expense.incurredOn)
    payableInvalid('event precedes the original expense date.');
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 0)
    payableInvalid('explicit event sequence is required.');
  text(event.evidenceRef, 'event evidence');
  if (original || event.source) source(event.source!);
  if (['hold', 'release', 'settlement'].includes(event.kind)) {
    minor((event as { amountMinor: number }).amountMinor);
    if (!(event as { amountMinor: number }).amountMinor)
      payableInvalid('event amount must be positive.');
  } else if (event.kind === 'refund') {
    text(event.refundExpenseId, 'refund Expense identity');
    minor(event.payableReductionMinor);
    minor(event.retainedReductionMinor);
    minor(event.cashReturnedMinor);
    if (event.retainedReductionMinor > event.payableReductionMinor)
      payableInvalid(
        'retained reduction exceeds the explicit payable reduction.',
      );
  } else payableInvalid('unsupported event kind.');
}
function bindEvent(
  event: SupplierPayableEventInput,
  expense: PayableExpense,
  refunds: PayableExpense[],
  original: boolean,
  input: SupplierPayableReview & { requestId: string },
  fingerprint: string,
): SupplierPayableEvent {
  validateEvent(event, expense, original);
  let refundFingerprint: string | undefined;
  if (event.kind === 'refund') {
    const refund = refunds.find((row) => row.id === event.refundExpenseId);
    if (
      !refund ||
      refund.refundOfId !== expense.id ||
      refund.tenantId !== expense.tenantId ||
      refund.currency !== expense.currency ||
      refund.amount >= 0
    )
      payableInvalid(
        'refund must be an actual same-owner linked negative Expense.',
      );
    if (event.effectiveOn !== refund.incurredOn)
      payableInvalid(
        'refund interpretation must preserve its actual effective date.',
      );
    if (
      event.payableReductionMinor > -refund.amount ||
      event.cashReturnedMinor > -refund.amount
    )
      payableInvalid(
        'refund interpretation exceeds its actual gross magnitude.',
      );
    refundFingerprint = payableExpenseFingerprint(refund);
  }
  return {
    ...event,
    id: randomUUID(),
    authority: original ? 'original' : 'current',
    requestId: input.requestId,
    requestFingerprint: fingerprint,
    recordedByProfileId: input.recordedByProfileId,
    recordedAt: new Date().toISOString(),
    ...(refundFingerprint ? { refundFingerprint } : {}),
  };
}
export function createSupplierPayable(
  expense: PayableExpense,
  input: RecordSupplierPayableInput,
  refunds: PayableExpense[],
): SupplierPayableState {
  if (!expense.id || expense.amount <= 0 || expense.refundOfId)
    payableInvalid('requires a persisted positive non-refund Expense.');
  review(input, expense);
  source(input.source);
  if (input.payableBasisMinor !== null) {
    minor(input.payableBasisMinor);
    if (input.payableBasisMinor > expense.amount)
      payableInvalid('basis exceeds original gross.');
  }
  if (!Array.isArray(input.events))
    payableInvalid('original events must be explicit.');
  const fingerprint = payableDigest(input);
  const state: SupplierPayableState = {
    version: 1,
    expenseId: expense.id,
    currency: expense.currency,
    expenseFingerprint: payableExpenseFingerprint(expense),
    original: {
      id: randomUUID(),
      requestId: input.requestId,
      requestFingerprint: fingerprint,
      source: input.source,
      payableBasisMinor: input.payableBasisMinor,
      recordedByProfileId: input.recordedByProfileId,
      evidenceRef: input.evidenceRef,
      recordedAt: new Date().toISOString(),
    },
    completion: null,
    events: input.events.map((event) =>
      bindEvent(event, expense, refunds, true, input, fingerprint),
    ),
  };
  supplierPayablePosition(expense, state, refunds);
  return state;
}
export function appendSupplierPayableEvent(
  expense: PayableExpense,
  state: SupplierPayableState,
  input: RecordSupplierPayableEventInput,
  refunds: PayableExpense[],
): SupplierPayableState {
  review(input, expense);
  const fingerprint = payableDigest(input);
  const existing = state.events.find(
    (event) => event.requestId === input.requestId,
  );
  if (
    existing ||
    state.original.requestId === input.requestId ||
    state.completion?.requestId === input.requestId
  ) {
    if (
      existing?.authority === 'current' &&
      existing.requestFingerprint === fingerprint
    )
      return state;
    return payableInvalid(
      'request identity conflicts with retained authority.',
    );
  }
  const before = supplierPayablePosition(expense, state, refunds);
  if (
    input.event?.kind === 'release' &&
    before.unresolvedRefundExpenseIds.length
  )
    payableInvalid('release requires every linked refund interpretation.');
  if (input.event?.kind === 'settlement' && before.unknownReasons.length)
    payableInvalid(
      'settlement requires known basis and every linked refund interpretation.',
    );
  const next = {
    ...state,
    events: [
      ...state.events,
      bindEvent(input.event, expense, refunds, false, input, fingerprint),
    ],
  };
  supplierPayablePosition(expense, next, refunds);
  return next;
}
export function completeSupplierPayable(
  expense: PayableExpense,
  state: SupplierPayableState,
  input: CompleteSupplierPayableBasisInput,
  refunds: PayableExpense[],
): SupplierPayableState {
  review(input, expense);
  minor(input.payableBasisMinor);
  const fingerprint = payableDigest(input);
  if (
    state.completion?.requestId === input.requestId &&
    state.completion.requestFingerprint === fingerprint
  )
    return state;
  if (
    state.original.payableBasisMinor !== null ||
    state.completion ||
    state.original.requestId === input.requestId ||
    state.events.some((event) => event.requestId === input.requestId)
  )
    payableInvalid('original basis or its explicit completion is immutable.');
  if (input.payableBasisMinor > expense.amount)
    payableInvalid('basis exceeds original gross.');
  const next = {
    ...state,
    completion: {
      ...input,
      id: randomUUID(),
      requestFingerprint: fingerprint,
      recordedAt: new Date().toISOString(),
    },
  };
  supplierPayablePosition(expense, next, refunds);
  return next;
}
/** Revalidates every historical prefix, even when projecting an earlier date. */
export function supplierPayablePosition(
  expense: PayableExpense,
  state: SupplierPayableState,
  refunds: PayableExpense[],
  asOfDate?: string,
): SupplierPayablePosition {
  if (asOfDate)
    assertIsoDate(
      'Expense',
      String(expense.id),
      'supplier payable as-of date',
      asOfDate,
    );
  if (
    state.expenseId !== expense.id ||
    state.currency !== expense.currency ||
    state.expenseFingerprint !== payableExpenseFingerprint(expense)
  )
    payableInvalid('canonical Expense authority changed.');
  const basis =
    state.completion?.payableBasisMinor ?? state.original.payableBasisMinor;
  if (basis !== null) {
    minor(basis);
    if (basis > expense.amount) payableInvalid('basis exceeds original gross.');
  }
  const tuples = new Set<string>(),
    originalKeys = new Set<string>(),
    refundIds = new Set<string>();
  let held = 0n,
    released = 0n,
    retainedReduction = 0n,
    settled = 0n,
    cashReturned = 0n,
    reduction = 0n;
  let projected = {
    held,
    released,
    retainedReduction,
    settled,
    cashReturned,
    reduction,
  };
  for (const event of [...state.events].sort(
    (a, b) =>
      a.effectiveOn.localeCompare(b.effectiveOn) || a.sequence - b.sequence,
  )) {
    validateEvent(event, expense, event.authority === 'original');
    const tuple = `${event.effectiveOn}:${event.sequence}`;
    if (tuples.has(tuple))
      payableInvalid('same-day chronology requires unique explicit sequence.');
    tuples.add(tuple);
    if (event.source) {
      const key = payableDigest([event.source.namespace, event.source.key]);
      if (originalKeys.has(key))
        payableInvalid('duplicate original event identity.');
      originalKeys.add(key);
    }
    if (event.kind === 'hold') held += BigInt(event.amountMinor);
    else if (event.kind === 'release') released += BigInt(event.amountMinor);
    else if (event.kind === 'settlement') settled += BigInt(event.amountMinor);
    else if (event.kind === 'refund') {
      if (refundIds.has(event.refundExpenseId))
        payableInvalid('refund already has a retained interpretation.');
      refundIds.add(event.refundExpenseId);
      const refund = refunds.find((row) => row.id === event.refundExpenseId);
      if (
        !refund ||
        event.refundFingerprint !== payableExpenseFingerprint(refund)
      )
        payableInvalid('interpreted refund authority changed or disappeared.');
      if (
        event.payableReductionMinor > -refund.amount ||
        event.cashReturnedMinor > -refund.amount
      )
        payableInvalid('refund interpretation exceeds source magnitude.');
      reduction += BigInt(event.payableReductionMinor);
      retainedReduction += BigInt(event.retainedReductionMinor);
      cashReturned += BigInt(event.cashReturnedMinor);
    }
    const retained = held - released - retainedReduction,
      paid = settled - cashReturned,
      obligation = BigInt(basis ?? expense.amount) - reduction;
    if (
      retained < 0n ||
      paid < 0n ||
      obligation < 0n ||
      obligation - paid - retained < 0n
    )
      payableInvalid('dated event exceeds retained, paid or payable capacity.');
    for (const value of [
      held,
      released,
      retainedReduction,
      settled,
      cashReturned,
      reduction,
    ])
      if (value > BigInt(Number.MAX_SAFE_INTEGER))
        payableInvalid('unsafe aggregate money.');
    if (!asOfDate || event.effectiveOn <= asOfDate)
      projected = {
        held,
        released,
        retainedReduction,
        settled,
        cashReturned,
        reduction,
      };
  }
  const unresolved = refunds
    .filter(
      (row) =>
        (!asOfDate || row.incurredOn <= asOfDate) &&
        !refundIds.has(String(row.id)),
    )
    .map((row) => String(row.id));
  const unknownReasons: SupplierPayablePosition['unknownReasons'] = [];
  if (basis === null) unknownReasons.push('payable-basis-unknown');
  if (unresolved.length) unknownReasons.push('refund-interpretation-required');
  const p = projected,
    retained = p.held - p.released - p.retainedReduction,
    paid = p.settled - p.cashReturned;
  return {
    expenseId: state.expenseId,
    currency: state.currency,
    asOfDate: asOfDate ?? null,
    payableBasisMinor: basis,
    heldMinor: Number(p.held),
    releasedMinor: Number(p.released),
    retainedReductionMinor: Number(p.retainedReduction),
    recordedRetainedMinor: Number(retained),
    retainedMinor: unresolved.length ? null : Number(retained),
    settledMinor: Number(p.settled),
    cashReturnedMinor: Number(p.cashReturned),
    netPaidMinor: unresolved.length ? null : Number(paid),
    payableReductionMinor: Number(p.reduction),
    remainingPayableMinor: unknownReasons.length
      ? null
      : Number(BigInt(basis!) - p.reduction - paid - retained),
    unknownReasons,
    unresolvedRefundExpenseIds: unresolved,
    authority: state,
  };
}
