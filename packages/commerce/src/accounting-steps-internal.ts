/** Shared durable provider step owner; internal, never a caller-writable state API. */
import { randomUUID } from 'node:crypto';
import type {
  AccountingProvider,
  QuickBooksReceivableReadback,
  QuickBooksReceivableRequest,
} from '@happyvertical/accounting';
import type { Invoice } from './models/Invoice.js';
import { MoneyValidationError } from './money.js';

interface ReconciliationEvidence {
  outcome: 'found' | 'absent';
  evidenceRef?: string;
  externalId?: string;
  recordedAt: string;
  interruptedOwnerStopped: boolean;
}
export interface AccountingStep {
  key: string;
  status: 'in_flight' | 'unknown' | 'rejected' | 'confirmed';
  attemptId: string;
  request: QuickBooksReceivableRequest;
  startedAt: string;
  result?: QuickBooksReceivableReadback;
  reconciliation?: ReconciliationEvidence;
  priorAttempts?: {
    attemptId: string;
    status: string;
    startedAt: string;
    reconciliation?: ReconciliationEvidence;
  }[];
}

export interface AccountingStepState {
  steps: AccountingStep[];
}
export interface AccountingStepEngine<S extends AccountingStepState> {
  locked<T>(
    operation: (invoice: Invoice, state: S | null) => Promise<T>,
  ): Promise<T>;
  save(invoice: Invoice, state: S): Promise<void>;
  provider: NonNullable<AccountingProvider['receivableTransfers']>;
}
export interface AccountingStepReconciliation {
  stepKey: string;
  requestId: string;
  attemptId: string;
  confirmInterruptedOwnerStopped?: true;
  outcome:
    | { status: 'found'; externalId: string }
    | { status: 'absent'; evidenceRef: string };
}
function reject(message: string): never {
  throw new MoneyValidationError(
    'ACCOUNTING_SYNC_RECONCILIATION_REQUIRED',
    message,
  );
}
function text(value: string, label: string) {
  if (typeof value !== 'string' || !value || value.trim() !== value)
    reject(`${label} is required`);
}
export async function executeAccountingStep<S extends AccountingStepState>(
  engine: AccountingStepEngine<S>,
  key: string,
  make: (invoice: Invoice, state: S) => QuickBooksReceivableRequest,
): Promise<QuickBooksReceivableReadback> {
  const prepared = await engine.locked(async (invoice, state) => {
    if (!state) reject('Retention provider contract is missing');
    const expected = make(invoice, state),
      prior = state.steps.find((s) => s.key === key);
    if (prior && prior.request.payloadHash !== expected.payloadHash)
      reject('Retention operation identity reused with changed facts');
    if (prior?.status === 'confirmed') {
      if (!prior.result) reject('Confirmed retention step has no readback');
      return { complete: prior.result } as const;
    }
    if (prior && prior.status !== 'rejected')
      reject('Retention operation has an unresolved remote owner');
    if (state.steps.some((s) => s.key !== key && s.status !== 'confirmed'))
      reject('Another retention operation requires reconciliation');
    const step: AccountingStep = {
      key,
      status: 'in_flight',
      attemptId: randomUUID(),
      request: expected,
      startedAt: new Date().toISOString(),
      priorAttempts: prior
        ? [
            ...(prior.priorAttempts ?? []),
            {
              attemptId: prior.attemptId,
              status: prior.status,
              startedAt: prior.startedAt,
              reconciliation: prior.reconciliation,
            },
          ]
        : [],
    };
    if (prior) state.steps[state.steps.indexOf(prior)] = step;
    else state.steps.push(step);
    await engine.save(invoice, state);
    return { step } as const;
  });
  if ('complete' in prepared && prepared.complete) return prepared.complete;
  if (!prepared.step) reject('Prepared retention step is missing');
  const step = prepared.step;
  let result: QuickBooksReceivableReadback;
  try {
    result = await engine.provider.execute(step.request);
  } catch (error) {
    await engine.locked(async (invoice, state) => {
      const current = state?.steps.find((s) => s.key === key);
      if (
        !state ||
        current?.attemptId !== step.attemptId ||
        current.status !== 'in_flight'
      )
        reject('Retention step ownership changed after remote failure');
      current.status =
        (error as { outcome?: string })?.outcome === 'rejected'
          ? 'rejected'
          : 'unknown';
      await engine.save(invoice, state);
    });
    throw error;
  }
  return engine.locked(async (invoice, state) => {
    const current = state?.steps.find((s) => s.key === key);
    if (
      !state ||
      current?.attemptId !== step.attemptId ||
      current.status !== 'in_flight' ||
      result.payloadHash !== step.request.payloadHash
    )
      reject('Retention step ownership or readback changed after write');
    current.status = 'confirmed';
    current.result = structuredClone(result);
    await engine.save(invoice, state);
    return result;
  });
}
export async function reconcileAccountingStep<S extends AccountingStepState>(
  engine: AccountingStepEngine<S>,
  input: AccountingStepReconciliation,
): Promise<S> {
  const step = await engine.locked(async (_invoice, state) => {
    const found = state?.steps.find((s) => s.key === input.stepKey);
    if (
      !found ||
      found.request.requestId !== input.requestId ||
      found.attemptId !== input.attemptId ||
      !['in_flight', 'unknown'].includes(found.status)
    )
      reject('Observed retention reconciliation owner differs');
    if (found.status === 'in_flight' && !input.confirmInterruptedOwnerStopped)
      reject('Interrupted retention owner must be proven stopped');
    return structuredClone(found);
  });
  const result =
    input.outcome.status === 'found'
      ? await engine.provider.read(step.request, input.outcome.externalId)
      : null;
  if (input.outcome.status === 'absent')
    text(input.outcome.evidenceRef, 'Authoritative provider absence evidence');
  return engine.locked(async (invoice, state) => {
    const current = state?.steps.find((s) => s.key === input.stepKey);
    if (
      !state ||
      current?.attemptId !== step.attemptId ||
      current.status !== step.status
    )
      reject('Retention reconciliation owner changed');
    current.reconciliation = {
      outcome: input.outcome.status,
      recordedAt: new Date().toISOString(),
      interruptedOwnerStopped: input.confirmInterruptedOwnerStopped === true,
      ...(input.outcome.status === 'found'
        ? { externalId: input.outcome.externalId }
        : { evidenceRef: input.outcome.evidenceRef }),
    };
    if (result) {
      if (result.payloadHash !== step.request.payloadHash)
        reject('Retention reconciliation readback differs');
      current.result = result;
      current.status = 'confirmed';
    } else current.status = 'rejected';
    await engine.save(invoice, state);
    return state;
  });
}
