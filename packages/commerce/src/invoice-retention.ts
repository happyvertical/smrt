/** Transactional retention commands. Hosts authorize actors and choose policy. */
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { getTenantId } from '@happyvertical/smrt-tenancy';
import { lockAndReloadInvoice } from './document-money.js';
import {
  DOCUMENT_MONEY_WRITE,
  withDocumentMoneyTransaction,
} from './document-money-internal.js';
import { MoneyValidationError } from './money.js';
import {
  assertRetentionMinor,
  calculateInvoicePayable,
  type InvoiceRetentionEvidence,
  type InvoiceRetentionState,
  parseInvoiceRetention,
  validateRetentionEvidence,
} from './retention-money.js';
import { lockTenantMoneyRuntime } from './tenant-money-barrier.js';
import { InvoiceStatus } from './types/index.js';

export interface InvoiceRetentionCommand extends InvoiceRetentionEvidence {
  db: DatabaseInterface;
  tenantId: string;
  invoiceId: string;
  currency: string;
  amountMinor: number;
  expectedUpdatedAt: string;
}
function reject(message: string): never {
  throw new MoneyValidationError('INVALID_MONEY_INPUT', message);
}
async function mutate(
  input: InvoiceRetentionCommand,
  creditPolicy?: 'retained-first',
) {
  validateRetentionEvidence(input);
  assertRetentionMinor(input.amountMinor, 'Retention amount');
  if (input.amountMinor <= 0) reject('Retention amount must be positive');
  if (!input.tenantId || (getTenantId() && getTenantId() !== input.tenantId))
    reject('Retention requires the active tenant');
  if (
    !input.expectedUpdatedAt ||
    !Number.isFinite(Date.parse(input.expectedUpdatedAt))
  )
    reject('Retention requires an expected invoice revision');
  return withDocumentMoneyTransaction(input.db, async (tx) => {
    await lockTenantMoneyRuntime(tx, input.tenantId);
    const { invoice } = await lockAndReloadInvoice(
      tx,
      input.invoiceId,
      input.tenantId,
    );
    if (invoice.currency !== input.currency || invoice.kind !== 'invoice')
      reject('Retention requires a matching invoice currency and kind');
    const state = parseInvoiceRetention(invoice.retentionStateJson);
    const prior = creditPolicy
      ? state
      : state?.releases.find((event) => event.requestId === input.requestId);
    if (prior?.requestId === input.requestId) {
      const priorAmount =
        'retainedMinor' in prior ? prior.retainedMinor : prior.amountMinor;
      if (
        priorAmount !== input.amountMinor ||
        (creditPolicy && state?.creditPolicy !== creditPolicy) ||
        [
          'policyVersion',
          'evidenceRef',
          'actorId',
          'reason',
          'effectiveOn',
        ].some(
          (key) =>
            prior[key as keyof InvoiceRetentionEvidence] !==
            input[key as keyof InvoiceRetentionEvidence],
        )
      )
        reject('Retention request identity reused with changed facts');
      return calculateInvoicePayable(invoice);
    }
    if (!invoice.updated_at) reject('Invoice has no persisted revision');
    if (
      new Date(invoice.updated_at).toISOString() !==
      new Date(input.expectedUpdatedAt).toISOString()
    )
      reject('Stale retention invoice revision');
    if (
      invoice.externalId ||
      invoice.externalProvider ||
      invoice.accountingSyncStateJson ||
      invoice.collectionMethod ||
      invoice.providerTaxAmount
    )
      reject(
        'Provider-controlled invoices require an explicit provider retention contract',
      );
    const evidence = {
      requestId: input.requestId,
      policyVersion: input.policyVersion,
      evidenceRef: input.evidenceRef,
      actorId: input.actorId,
      reason: input.reason,
      ...(input.effectiveOn === undefined
        ? {}
        : { effectiveOn: input.effectiveOn }),
      recordedAt: new Date().toISOString(),
    };
    let next: InvoiceRetentionState;
    if (creditPolicy) {
      if (creditPolicy !== 'retained-first')
        reject('Unsupported retention credit policy');
      if (state)
        reject('Retention configuration is immutable; create a new draft');
      if (
        invoice.status !== InvoiceStatus.DRAFT ||
        invoice.moneySnapshotId ||
        invoice.arJournalId ||
        invoice.amountPaid
      )
        reject('Retention can only be configured on an unpaid draft');
      next = {
        ...evidence,
        version: 1,
        currency: input.currency,
        creditPolicy,
        retainedMinor: input.amountMinor,
        releases: [],
      };
    } else {
      if (
        !state ||
        !invoice.moneySnapshotId ||
        [
          InvoiceStatus.DRAFT,
          InvoiceStatus.CANCELLED,
          InvoiceStatus.WRITTEN_OFF,
        ].includes(invoice.status)
      )
        reject('Retention release requires an issued active retained invoice');
      if (input.requestId === state.requestId)
        reject('Retention request identity already configured');
      if (
        input.amountMinor >
        calculateInvoicePayable(invoice).retainedRemainingMinor
      )
        reject('Release exceeds remaining retention');
      next = {
        ...state,
        releases: [
          ...state.releases,
          { ...evidence, amountMinor: input.amountMinor },
        ],
      };
    }
    invoice.retentionStateJson = JSON.stringify(next);
    const facts = calculateInvoicePayable(invoice);
    await invoice.saveDerived(DOCUMENT_MONEY_WRITE);
    return facts;
  });
}
export function configureInvoiceRetention(
  input: InvoiceRetentionCommand & { creditPolicy: 'retained-first' },
) {
  if (input.creditPolicy !== 'retained-first')
    reject('Explicit supported retention credit policy is required');
  return mutate(input, input.creditPolicy);
}
export function releaseInvoiceRetention(input: InvoiceRetentionCommand) {
  return mutate(input);
}
