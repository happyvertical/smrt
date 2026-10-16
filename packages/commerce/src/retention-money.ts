/** Explicit retained-first settlement policy; no jurisdiction defaults. */
import { MoneyValidationError } from './money.js';

export interface InvoiceRetentionEvidence {
  requestId: string;
  policyVersion: string;
  evidenceRef: string;
  actorId: string;
  reason: string;
  /** Original calendar date only for immutable imported evidence; recordedAt stays actual record time. */
  effectiveOn?: string;
  sameDayCreditOrder?: 'credit-before-release' | 'release-before-credit' | null;
}
export interface InvoiceRetentionRelease extends InvoiceRetentionEvidence {
  amountMinor: number;
  recordedAt: string;
}
export interface InvoiceRetentionState extends InvoiceRetentionEvidence {
  version: 1;
  currency: string;
  creditPolicy: 'retained-first';
  retainedMinor: number;
  recordedAt: string;
  releases: InvoiceRetentionRelease[];
}
export interface InvoicePayableFacts {
  grossMinor: number;
  retainedMinor: number;
  releasedMinor: number;
  creditedRetentionMinor: number;
  retainedRemainingMinor: number;
  allocationCapMinor: number;
  grossBalanceMinor: number;
  currentlyDueMinor: number;
}
function invalid(message: string): never {
  throw new MoneyValidationError('INVALID_MONEY_INPUT', message);
}
export function assertRetentionMinor(amount: number, label: string): void {
  if (!Number.isSafeInteger(amount))
    invalid(`${label} must be a safe integer minor-unit amount`);
}
export function validateRetentionEvidence(
  input: InvoiceRetentionEvidence,
): void {
  for (const key of [
    'requestId',
    'policyVersion',
    'evidenceRef',
    'actorId',
    'reason',
  ] as const) {
    const value = input[key];
    if (typeof value !== 'string' || !value || value.trim() !== value)
      invalid(`Retention ${key} must be nonempty trimmed text`);
  }
}
export function parseInvoiceRetention(
  json: string,
): InvoiceRetentionState | null {
  if (json === '') return null;
  let state: InvoiceRetentionState;
  try {
    state = JSON.parse(json);
  } catch {
    return invalid('Invalid retention state JSON');
  }
  if (
    !state ||
    state.version !== 1 ||
    state.creditPolicy !== 'retained-first' ||
    !Array.isArray(state.releases)
  )
    invalid('Unsupported retention state or credit policy');
  validateRetentionEvidence(state);
  if (!/^[A-Z]{3}$/.test(state.currency))
    invalid('Retention currency is required');
  const keys = new Set([state.requestId]);
  for (const event of [state, ...state.releases]) {
    validateRetentionEvidence(event);
    if (
      typeof event.recordedAt !== 'string' ||
      !Number.isFinite(Date.parse(event.recordedAt))
    )
      invalid('Retention event timestamp is required');
    if (
      event.effectiveOn !== undefined &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(event.effectiveOn) ||
        !Number.isFinite(Date.parse(event.effectiveOn)) ||
        new Date(event.effectiveOn).toISOString().slice(0, 10) !==
          event.effectiveOn)
    )
      invalid('Original retention event requires an exact calendar date');
    if (
      event.sameDayCreditOrder !== undefined &&
      event.sameDayCreditOrder !== null &&
      event.sameDayCreditOrder !== 'release-before-credit' &&
      event.sameDayCreditOrder !== 'credit-before-release'
    )
      invalid('Unsupported original retention release/credit ordering');
    if (event !== state) {
      if (keys.has(event.requestId))
        invalid('Duplicate retention request identity');
      keys.add(event.requestId);
    }
  }
  return state;
}
export function calculateInvoicePayable(input: {
  totalAmount: number;
  creditedAmount: number;
  amountPaid: number;
  currency: string;
  retentionStateJson?: string;
}): InvoicePayableFacts {
  for (const [name, amount] of Object.entries({
    gross: input.totalAmount,
    credits: input.creditedAmount,
    paid: input.amountPaid,
  })) {
    assertRetentionMinor(amount, name);
    if (amount < 0) invalid(`${name} cannot be negative`);
  }
  if (
    input.creditedAmount > input.totalAmount ||
    input.amountPaid > input.totalAmount
  )
    invalid('Credits or payments exceed invoice gross');
  const state = parseInvoiceRetention(input.retentionStateJson ?? '');
  const retained = state?.retainedMinor ?? 0;
  assertRetentionMinor(retained, 'Retained amount');
  if (retained < 0 || retained > input.totalAmount)
    invalid('Retention exceeds invoice gross');
  if (state && state.currency !== input.currency)
    invalid('Retention currency does not match invoice');
  let released = 0n;
  for (const event of state?.releases ?? []) {
    assertRetentionMinor(event.amountMinor, 'Released amount');
    if (event.amountMinor <= 0) invalid('Release amount must be positive');
    released += BigInt(event.amountMinor);
  }
  if (released > BigInt(retained)) invalid('Releases exceed retained amount');
  const unreleased = retained - Number(released);
  const creditedRetention = Math.min(unreleased, input.creditedAmount);
  const remaining = unreleased - creditedRetention;
  const cap = Math.max(0, input.totalAmount - input.creditedAmount - remaining);
  return {
    grossMinor: input.totalAmount,
    retainedMinor: retained,
    releasedMinor: Number(released),
    creditedRetentionMinor: creditedRetention,
    retainedRemainingMinor: remaining,
    allocationCapMinor: cap,
    grossBalanceMinor:
      input.totalAmount - input.creditedAmount - input.amountPaid,
    currentlyDueMinor: Math.max(0, cap - input.amountPaid),
  };
}
