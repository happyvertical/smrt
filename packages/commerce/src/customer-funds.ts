/** Conserved customer advances with explicit policy and real ledger reclassification. */
import { createHash } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { getTenantId } from '@happyvertical/smrt-tenancy';
import { ISO_4217_MINOR_UNITS } from '@happyvertical/smrt-ui/currency';
import { ContractCollection } from './collections/ContractCollection.js';
import { CustomerCollection } from './collections/CustomerCollection.js';
import { InvoiceCollection } from './collections/InvoiceCollection.js';
import { PaymentAllocationCollection } from './collections/PaymentAllocationCollection.js';
import { PaymentCollection } from './collections/PaymentCollection.js';
import {
  customerFundsState,
  withCustomerFundsWrite,
} from './customer-funds-internal.js';
import { Payment } from './models/Payment.js';
import { PaymentAllocation } from './models/PaymentAllocation.js';
import { withTenantMoneyRuntime } from './tenant-money-barrier.js';
import { PaymentMethod } from './types/index.js';

/** Explicit reviewed policy. Ledgers uses one tenant chart with currency on each entry. */
export interface CustomerFundsPolicy {
  version: string;
  mode: 'unapplied-ar' | 'deposit-liability';
  taxTiming: 'invoice-tax-point';
  releaseEligibility: 'any-issued-invoice' | 'final-invoice-only';
  cashAccountId: string;
  receivablesAccountId: string;
  liabilityAccountId: string | null;
}
/** Immutable host approval attestation, bound to the actual issued monetary snapshot. */
export interface CustomerFundsReleaseEvidence {
  kind: 'issued-invoice' | 'final-invoice';
  invoiceSnapshotId: string;
  approvalEvidenceRef: string;
  policyVersion: string;
}
interface Evidence {
  requestId: string;
  evidenceRef: string;
  actorId: string;
  effectiveOn: string;
}
/** Historical operations remain after an allocation is reversed. */
export interface CustomerFundsOperation extends Evidence {
  kind: 'allocate' | 'refund' | 'reverse';
  amountMinor: number;
  allocationId: string | null;
  invoiceId: string | null;
  refundPaymentId: string | null;
  reversesRequestId: string | null;
  release: CustomerFundsReleaseEvidence | null;
  journalId: string | null;
  recordedAt: string;
}
/** Persisted command authority; callers should read CustomerFundsFacts instead. */
export interface CustomerFundsState extends Evidence {
  version: 1;
  kind: 'receipt' | 'refund';
  policy: CustomerFundsPolicy;
  sourcePaymentId: string | null;
  /** Present only on a new journal-backed refund of retained original cash. */
  sourceHistoricalReceiptId?: string | null;
  requestFingerprint: string;
  recordedAt: string;
  operations: CustomerFundsOperation[];
}
/** Exact conserved balance and historical provenance. */
export interface CustomerFundsFacts {
  paymentId: string;
  tenantId: string;
  customerId: string;
  contractId: string | null;
  currency: string;
  receivedMinor: number;
  allocatedMinor: number;
  refundedMinor: number;
  availableMinor: number;
  receiptJournalId: string;
  receipt: CustomerFundsState;
}
interface Context {
  db: DatabaseInterface;
  tenantId: string;
}
export interface RecordCustomerFundsInput extends Context, Evidence {
  customerId: string;
  contractId?: string | null;
  currency: string;
  amountMinor: number;
  method: PaymentMethod;
  policy: CustomerFundsPolicy;
}
export interface AllocateCustomerFundsInput extends Context, Evidence {
  paymentId: string;
  invoiceId: string;
  amountMinor: number;
  release: CustomerFundsReleaseEvidence;
}
export interface RefundCustomerFundsInput extends Context, Evidence {
  paymentId: string;
  amountMinor: number;
  method: PaymentMethod;
}
export interface ReverseCustomerFundsAllocationInput extends Context, Evidence {
  paymentId: string;
  allocationRequestId: string;
}
function text(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > 2000
  )
    throw new Error(`${label} requires nonempty trimmed text`);
  return value;
}
function amount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new Error('Customer funds amount must be a positive safe integer');
  return value;
}
function evidence(input: Evidence): Evidence {
  const effectiveOn = text(input.effectiveOn, 'Effective date');
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(effectiveOn) ||
    !Number.isFinite(Date.parse(effectiveOn)) ||
    new Date(effectiveOn).toISOString().slice(0, 10) !== effectiveOn
  )
    throw new Error('Effective date must be a calendar date');
  return {
    requestId: text(input.requestId, 'Request'),
    evidenceRef: text(input.evidenceRef, 'Evidence'),
    actorId: text(input.actorId, 'Actor'),
    effectiveOn,
  };
}
function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function identity(value: unknown): string {
  const h = hash(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function context(input: Context): void {
  text(input.tenantId, 'Tenant');
  if (getTenantId() !== input.tenantId)
    throw new Error('Customer funds require the explicit active tenant');
}
export function validateCustomerFundsPolicy(
  input: CustomerFundsPolicy,
): CustomerFundsPolicy {
  if (
    !input ||
    !['unapplied-ar', 'deposit-liability'].includes(input.mode) ||
    input.taxTiming !== 'invoice-tax-point' ||
    !['any-issued-invoice', 'final-invoice-only'].includes(
      input.releaseEligibility,
    )
  )
    throw new Error(
      'Explicit supported customer-funds accounting, tax timing and release policy required',
    );
  const result = {
    version: text(input.version, 'Policy version'),
    mode: input.mode,
    taxTiming: input.taxTiming,
    releaseEligibility: input.releaseEligibility,
    cashAccountId: text(input.cashAccountId, 'Cash account'),
    receivablesAccountId: text(
      input.receivablesAccountId,
      'Receivables account',
    ),
    liabilityAccountId:
      input.mode === 'deposit-liability'
        ? text(input.liabilityAccountId, 'Customer liability account')
        : null,
  };
  if (input.mode === 'unapplied-ar' && input.liabilityAccountId !== null)
    throw new Error(
      'Unapplied AR policy must explicitly omit liability account',
    );
  const ids = [
    result.cashAccountId,
    result.receivablesAccountId,
    result.liabilityAccountId,
  ].filter(Boolean);
  if (new Set(ids).size !== ids.length)
    throw new Error('Customer-funds accounts must be distinct');
  return result;
}
export async function validateCustomerFundsAccounts(
  db: DatabaseInterface,
  tenantId: string,
  rule: CustomerFundsPolicy,
): Promise<void> {
  const { AccountCollection } = await import('@happyvertical/smrt-ledgers');
  const collection = await AccountCollection.create({ db });
  for (const [id, type] of [
    [rule.cashAccountId, 'asset'],
    [rule.receivablesAccountId, 'asset'],
    ...(rule.liabilityAccountId
      ? [[rule.liabilityAccountId, 'liability']]
      : []),
  ]) {
    const account = await collection.get({ id }, { cache: false });
    if (
      !account ||
      account.tenantId !== tenantId ||
      account.type !== type ||
      !account.active
    )
      throw new Error(
        'Customer-funds account is not active in the tenant chart with the required type',
      );
  }
}
async function source(
  db: DatabaseInterface,
  tenantId: string,
  paymentId: string,
) {
  const payments = await PaymentCollection.create({ db });
  const payment = await payments.get(
    { id: text(paymentId, 'Source payment') },
    { cache: false },
  );
  if (
    !payment ||
    payment.tenantId !== tenantId ||
    payment.kind !== 'payment' ||
    payment.status !== 'completed'
  )
    throw new Error('Customer-funds receipt is unavailable in this tenant');
  const state = customerFundsState(payment.customerFundsJson);
  if (!state || state.kind !== 'receipt' || !payment.customerId)
    throw new Error('Payment is not a managed customer-funds receipt');
  if (!payment.updated_at) throw new Error('Receipt revision is unavailable');
  await payment.claimRevision(payment.updated_at);
  return { payment, state };
}
function chronological(state: CustomerFundsState, effectiveOn: string): void {
  if (
    [state.effectiveOn, ...state.operations.map((op) => op.effectiveOn)].some(
      (date) => date > effectiveOn,
    )
  )
    throw new Error(
      'Customer-funds effective date cannot precede an already recorded movement',
    );
}
async function facts(
  db: DatabaseInterface,
  payment: Payment,
  state: CustomerFundsState,
): Promise<CustomerFundsFacts> {
  const { JournalCollection } = await import('@happyvertical/smrt-ledgers');
  const journals = await JournalCollection.create({ db });
  for (const journalId of [
    payment.journalId,
    ...state.operations
      .map((op) => op.journalId)
      .filter((id): id is string => Boolean(id)),
  ]) {
    const journal = await journals.get({ id: journalId }, { cache: false });
    if (
      !journal ||
      journal.tenantId !== payment.tenantId ||
      journal.status !== 'posted'
    )
      throw new Error(
        'Customer funds require their original posted ledger evidence',
      );
  }
  const allocations = await (
    await PaymentAllocationCollection.create({ db })
  ).findByPayment(payment.id!);
  const active = state.operations.filter(
    (op) =>
      op.kind === 'allocate' &&
      !state.operations.some(
        (reverse) =>
          reverse.kind === 'reverse' &&
          reverse.reversesRequestId === op.requestId,
      ),
  );
  if (
    allocations.length !== active.length ||
    allocations.some(
      (row) =>
        !active.some(
          (op) =>
            op.allocationId === row.id &&
            op.invoiceId === row.invoiceId &&
            op.amountMinor === row.amount,
        ),
    )
  )
    throw new Error('Customer funds allocation evidence does not reconcile');
  const payments = await PaymentCollection.create({ db });
  for (const op of state.operations.filter((row) => row.kind === 'refund')) {
    const refund = await payments.get(
      { id: op.refundPaymentId! },
      { cache: false },
    );
    const lineage = customerFundsState(refund?.customerFundsJson);
    if (
      !refund ||
      refund.tenantId !== payment.tenantId ||
      refund.customerId !== payment.customerId ||
      refund.currency !== payment.currency ||
      refund.kind !== 'refund' ||
      refund.status !== 'completed' ||
      refund.amount !== op.amountMinor ||
      refund.journalId !== op.journalId ||
      lineage?.sourcePaymentId !== payment.id
    )
      throw new Error('Customer funds refund evidence does not reconcile');
  }
  const allocated = active.reduce(
    (sum, op) => sum + BigInt(op.amountMinor),
    0n,
  );
  const refunded = state.operations
    .filter((op) => op.kind === 'refund')
    .reduce((sum, op) => sum + BigInt(op.amountMinor), 0n);
  const available = BigInt(payment.amount) - allocated - refunded;
  if (available < 0n || available > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Customer funds capacity does not reconcile');
  return {
    paymentId: payment.id!,
    tenantId: payment.tenantId!,
    customerId: payment.customerId!,
    contractId: payment.contractId,
    currency: payment.currency,
    receivedMinor: payment.amount,
    allocatedMinor: Number(allocated),
    refundedMinor: Number(refunded),
    availableMinor: Number(available),
    receiptJournalId: payment.journalId,
    receipt: structuredClone(state),
  };
}
async function persist(
  db: DatabaseInterface,
  paymentId: string,
  state: CustomerFundsState,
) {
  const payment = (await (
    await PaymentCollection.create({ db })
  ).get({ id: paymentId }, { cache: false }))!;
  payment.customerFundsJson = JSON.stringify(state);
  await withCustomerFundsWrite(payment, () => payment.save());
  return facts(db, payment, state);
}
async function settle(
  db: DatabaseInterface,
  input: {
    id: string;
    tenantId: string;
    customerId: string;
    contractId: string | null;
    currency: string;
    amountMinor: number;
    method: PaymentMethod;
    kind: 'payment' | 'refund';
    state: CustomerFundsState;
  },
) {
  if (!Object.values(PaymentMethod).includes(input.method))
    throw new Error('Explicit supported payment method required');
  const payment = new Payment({
    db,
    id: input.id,
    tenantId: input.tenantId,
    customerId: input.customerId,
    contractId: input.contractId,
    currency: input.currency,
    amount: input.amountMinor,
    method: input.method,
    kind: input.kind,
    reference: input.state.evidenceRef,
    customerFundsJson: JSON.stringify(input.state),
  });
  await payment.initialize();
  await withCustomerFundsWrite(payment, async () => {
    await payment.save();
    await payment.recordPayment({
      ledgerId: '',
      cashAccountId: input.state.policy.cashAccountId,
      receivablesAccountId: input.state.policy.receivablesAccountId,
    });
  });
  return payment;
}
/** Record an explicit customer advance. The host authorizes the receipt and its policy. */
export async function recordCustomerFunds(
  input: RecordCustomerFundsInput,
): Promise<CustomerFundsFacts> {
  context(input);
  const request = {
    ...evidence(input),
    customerId: text(input.customerId, 'Customer'),
    contractId: input.contractId
      ? text(input.contractId, 'Sales contract')
      : null,
    currency: text(input.currency, 'Currency'),
    amountMinor: amount(input.amountMinor),
    method: input.method,
    policy: validateCustomerFundsPolicy(input.policy),
  };
  if (
    !ISO_4217_MINOR_UNITS.has(request.currency) ||
    ISO_4217_MINOR_UNITS.get(request.currency) === null
  )
    throw new Error('Unsupported customer-funds currency');
  return withTenantMoneyRuntime(input.db, input.tenantId, async ({ db }) => {
    const id = identity(['customer-funds', input.tenantId, request.requestId]);
    const existing = await (await PaymentCollection.create({ db })).get(
      { id },
      { cache: false },
    );
    if (existing) {
      const state = customerFundsState(existing.customerFundsJson);
      if (
        existing.tenantId !== input.tenantId ||
        !state ||
        state.kind !== 'receipt' ||
        state.requestFingerprint !== hash(request)
      )
        throw new Error('Customer funds receipt replay differs');
      return facts(db, existing, state);
    }
    const customer = await (await CustomerCollection.create({ db })).get(
      request.customerId,
    );
    if (
      !customer ||
      customer.tenantId !== input.tenantId ||
      customer.status !== 'active'
    )
      throw new Error('Customer is unavailable in this tenant');
    if (request.contractId) {
      const contract = await (await ContractCollection.create({ db })).get(
        request.contractId,
      );
      if (
        !contract ||
        contract.tenantId !== input.tenantId ||
        !('customerId' in contract) ||
        contract.customerId !== request.customerId ||
        contract.currency !== request.currency ||
        contract.status === 'cancelled'
      )
        throw new Error('Sales contract does not match customer funds');
    }
    await validateCustomerFundsAccounts(db, input.tenantId, request.policy);
    const state: CustomerFundsState = {
      version: 1,
      kind: 'receipt',
      ...evidence(input),
      policy: request.policy,
      sourcePaymentId: null,
      requestFingerprint: hash(request),
      recordedAt: new Date().toISOString(),
      operations: [],
    };
    const payment = await settle(db, {
      ...request,
      tenantId: input.tenantId,
      id,
      kind: 'payment',
      state,
    });
    return facts(db, payment, state);
  });
}
/** Read exact available cash; access authorization remains with the host. */
export async function getCustomerFundsFacts(
  input: Context & { paymentId: string },
): Promise<CustomerFundsFacts> {
  context(input);
  return withTenantMoneyRuntime(input.db, input.tenantId, async ({ db }) => {
    const { payment, state } = await source(
      db,
      input.tenantId,
      input.paymentId,
    );
    return facts(db, payment, state);
  });
}
function replay(
  state: CustomerFundsState,
  operation: Omit<CustomerFundsOperation, 'journalId' | 'recordedAt'>,
): boolean {
  const previous = state.operations.find(
    (op) => op.requestId === operation.requestId,
  );
  if (!previous) return false;
  const { journalId: _journal, recordedAt: _recorded, ...request } = previous;
  if (JSON.stringify(request) !== JSON.stringify(operation))
    throw new Error('Customer funds operation replay differs');
  return true;
}
export async function postCustomerFundsReclassification(
  db: DatabaseInterface,
  payment: Pick<Payment, 'id' | 'currency'>,
  state: Pick<CustomerFundsState, 'policy'>,
  operation: Pick<
    CustomerFundsOperation,
    'requestId' | 'evidenceRef' | 'effectiveOn' | 'amountMinor'
  >,
  reverse: boolean,
  sourceKind: 'payment' | 'historical-receipt' = 'payment',
): Promise<string | null> {
  if (state.policy.mode === 'unapplied-ar') return null;
  const { JournalCollection } = await import('@happyvertical/smrt-ledgers');
  const journal = await (await JournalCollection.create({ db })).create({
    date: new Date(`${operation.effectiveOn}T12:00:00Z`),
    description: reverse
      ? 'Customer advance application reversal'
      : 'Customer advance applied to receivable',
    sourceModule: 'smrt-commerce',
    sourceRef: payment.id!,
    metadata: {
      ...(sourceKind === 'payment'
        ? { paymentId: payment.id }
        : { historicalReceiptId: payment.id }),
      requestId: operation.requestId,
      evidenceRef: operation.evidenceRef,
    },
  });
  await journal.addEntry({
    accountId: state.policy.liabilityAccountId!,
    currency: payment.currency,
    debit: reverse ? 0 : operation.amountMinor,
    credit: reverse ? operation.amountMinor : 0,
  });
  await journal.addEntry({
    accountId: state.policy.receivablesAccountId,
    currency: payment.currency,
    debit: reverse ? operation.amountMinor : 0,
    credit: reverse ? 0 : operation.amountMinor,
  });
  await journal.post();
  return journal.id!;
}
/** Apply available cash to an issued snapshot under the frozen release policy. */
export async function allocateCustomerFunds(
  input: AllocateCustomerFundsInput,
): Promise<CustomerFundsFacts> {
  context(input);
  const ev = evidence(input);
  const release = input.release;
  if (!release || !['issued-invoice', 'final-invoice'].includes(release.kind))
    throw new Error('Explicit invoice release evidence required');
  const operation = {
    ...ev,
    kind: 'allocate' as const,
    amountMinor: amount(input.amountMinor),
    allocationId: identity([
      'customer-funds-allocation',
      input.tenantId,
      input.paymentId,
      ev.requestId,
    ]),
    invoiceId: text(input.invoiceId, 'Invoice'),
    refundPaymentId: null,
    reversesRequestId: null,
    release: {
      kind: release.kind,
      invoiceSnapshotId: text(
        release.invoiceSnapshotId,
        'Invoice monetary snapshot',
      ),
      approvalEvidenceRef: text(
        release.approvalEvidenceRef,
        'Frozen host approval',
      ),
      policyVersion: text(release.policyVersion, 'Release policy version'),
    },
  };
  return withTenantMoneyRuntime(input.db, input.tenantId, async ({ db }) => {
    const { payment, state } = await source(
      db,
      input.tenantId,
      input.paymentId,
    );
    if (replay(state, operation)) return facts(db, payment, state);
    chronological(state, operation.effectiveOn);
    if (
      release.policyVersion !== state.policy.version ||
      (state.policy.releaseEligibility === 'final-invoice-only' &&
        release.kind !== 'final-invoice')
    )
      throw new Error(
        'Invoice release does not satisfy the frozen customer-funds policy',
      );
    if (
      operation.amountMinor > (await facts(db, payment, state)).availableMinor
    )
      throw new Error('Insufficient unallocated customer funds');
    const invoices = await InvoiceCollection.create({ db });
    const invoice = await invoices.get(
      { id: operation.invoiceId },
      { cache: false },
    );
    if (
      !invoice ||
      invoice.tenantId !== input.tenantId ||
      invoice.customerId !== payment.customerId ||
      invoice.currency !== payment.currency ||
      invoice.kind !== 'invoice' ||
      !['sent', 'viewed', 'partial', 'paid', 'overdue'].includes(
        invoice.status,
      ) ||
      !invoice.moneySnapshotId ||
      invoice.moneySnapshotId !== release.invoiceSnapshotId ||
      (payment.contractId && invoice.contractId !== payment.contractId)
    )
      throw new Error(
        'Issued invoice does not match the customer funds and approved snapshot',
      );
    await validateCustomerFundsAccounts(db, input.tenantId, state.policy);
    const allocation = new PaymentAllocation({
      db,
      id: operation.allocationId,
      tenantId: input.tenantId,
      paymentId: payment.id!,
      invoiceId: invoice.id!,
      amount: operation.amountMinor,
      allocatedBy: ev.actorId,
      allocatedAt: new Date(`${ev.effectiveOn}T12:00:00Z`),
      notes: ev.evidenceRef,
    });
    await allocation.initialize();
    await withCustomerFundsWrite(allocation, () => allocation.save());
    const journalId = await postCustomerFundsReclassification(
      db,
      payment,
      state,
      operation,
      false,
    );
    await invoice.loadFromId();
    invoice.updatePaymentStatus(
      await (
        await PaymentAllocationCollection.create({ db })
      ).getTotalAllocatedToInvoice(invoice.id!),
    );
    await invoice.save();
    state.operations.push({
      ...operation,
      journalId,
      recordedAt: new Date().toISOString(),
    });
    return persist(db, payment.id!, state);
  });
}
/** Refund only currently unallocated receipt funds, with immutable source lineage. */
export async function refundCustomerFunds(
  input: RefundCustomerFundsInput,
): Promise<CustomerFundsFacts> {
  context(input);
  const ev = evidence(input);
  const operation = {
    ...ev,
    kind: 'refund' as const,
    amountMinor: amount(input.amountMinor),
    allocationId: null,
    invoiceId: null,
    refundPaymentId: identity([
      'customer-funds-refund',
      input.tenantId,
      input.paymentId,
      ev.requestId,
    ]),
    reversesRequestId: null,
    release: null,
  };
  return withTenantMoneyRuntime(input.db, input.tenantId, async ({ db }) => {
    const { payment, state } = await source(
      db,
      input.tenantId,
      input.paymentId,
    );
    if (replay(state, operation)) {
      const refund = await (await PaymentCollection.create({ db })).get(
        operation.refundPaymentId,
      );
      if (!refund || refund.method !== input.method)
        throw new Error('Customer funds refund replay differs');
      return facts(db, payment, state);
    }
    chronological(state, operation.effectiveOn);
    if (
      operation.amountMinor > (await facts(db, payment, state)).availableMinor
    )
      throw new Error('Refund exceeds unallocated customer funds');
    await validateCustomerFundsAccounts(db, input.tenantId, state.policy);
    const refundState: CustomerFundsState = {
      version: 1,
      kind: 'refund',
      ...ev,
      policy: state.policy,
      sourcePaymentId: payment.id!,
      requestFingerprint: hash({ operation, method: input.method }),
      recordedAt: new Date().toISOString(),
      operations: [],
    };
    const refund = await settle(db, {
      id: operation.refundPaymentId,
      tenantId: input.tenantId,
      customerId: payment.customerId!,
      contractId: payment.contractId,
      currency: payment.currency,
      amountMinor: operation.amountMinor,
      method: input.method,
      kind: 'refund',
      state: refundState,
    });
    state.operations.push({
      ...operation,
      journalId: refund.journalId,
      recordedAt: new Date().toISOString(),
    });
    return persist(db, payment.id!, state);
  });
}
/** Undo an application with an inverse journal; retain the original operation and its reversal. */
export async function reverseCustomerFundsAllocation(
  input: ReverseCustomerFundsAllocationInput,
): Promise<CustomerFundsFacts> {
  context(input);
  const ev = evidence(input);
  return withTenantMoneyRuntime(input.db, input.tenantId, async ({ db }) => {
    const { payment, state } = await source(
      db,
      input.tenantId,
      input.paymentId,
    );
    const original = state.operations.find(
      (op) =>
        op.kind === 'allocate' &&
        op.requestId ===
          text(input.allocationRequestId, 'Original application'),
    );
    if (!original) throw new Error('Customer funds application not found');
    const operation = {
      ...ev,
      kind: 'reverse' as const,
      amountMinor: original.amountMinor,
      allocationId: original.allocationId,
      invoiceId: original.invoiceId,
      refundPaymentId: null,
      reversesRequestId: original.requestId,
      release: null,
    };
    if (replay(state, operation)) return facts(db, payment, state);
    if (
      state.operations.some(
        (op) =>
          op.kind === 'reverse' && op.reversesRequestId === original.requestId,
      )
    )
      throw new Error('Customer funds application is already reversed');
    chronological(state, ev.effectiveOn);
    await facts(db, payment, state);
    await validateCustomerFundsAccounts(db, input.tenantId, state.policy);
    const allocations = await PaymentAllocationCollection.create({ db });
    const allocation = await allocations.get(
      { id: original.allocationId! },
      { cache: false },
    );
    if (!allocation)
      throw new Error('Customer funds application does not reconcile');
    const invoice = await (await InvoiceCollection.create({ db })).get(
      { id: original.invoiceId! },
      { cache: false },
    );
    if (!invoice || invoice.tenantId !== input.tenantId)
      throw new Error('Customer funds invoice is unavailable');
    if (
      invoice.kind !== 'invoice' ||
      invoice.status === 'written_off' ||
      invoice.status === 'cancelled'
    )
      throw new Error(
        'Resolve the terminal invoice before reversing customer funds',
      );
    const credits = await (await InvoiceCollection.create({ db })).list({
      where: { creditedInvoiceId: invoice.id },
    });
    for (const credit of credits) {
      if (
        credit.kind === 'credit_note' &&
        ((credit.status !== 'draft' && credit.status !== 'cancelled') ||
          (await allocations.findByInvoice(credit.id!)).length)
      )
        throw new Error(
          'Issued credit or credit refund consumes this settlement; resolve it before application reversal',
        );
    }
    const journalId = await postCustomerFundsReclassification(
      db,
      payment,
      state,
      operation,
      true,
    );
    await withCustomerFundsWrite(allocation, () => allocation.delete());
    await invoice.loadFromId();
    invoice.updatePaymentStatus(
      await allocations.getTotalAllocatedToInvoice(invoice.id!),
    );
    await invoice.save();
    state.operations.push({
      ...operation,
      journalId,
      recordedAt: new Date().toISOString(),
    });
    return persist(db, payment.id!, state);
  });
}
