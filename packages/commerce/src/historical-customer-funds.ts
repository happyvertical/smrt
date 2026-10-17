/** Retained original cash is factual authority, never a forged completed Payment. */
import { createHash } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { getTenantId } from '@happyvertical/smrt-tenancy';
import { ISO_4217_MINOR_UNITS } from '@happyvertical/smrt-ui/currency';
import { ContractCollection } from './collections/ContractCollection.js';
import { CustomerCollection } from './collections/CustomerCollection.js';
import {
  HistoricalCustomerFundsAllocationCollection,
  HistoricalCustomerFundsCollection,
} from './collections/HistoricalCustomerFundsCollections.js';
import { InvoiceCollection } from './collections/InvoiceCollection.js';
import { PaymentAllocationCollection } from './collections/PaymentAllocationCollection.js';
import { PaymentCollection } from './collections/PaymentCollection.js';
import { calculateAvailableRefund } from './credit-allocation.js';
import type {
  CustomerFundsReleaseEvidence,
  CustomerFundsState,
} from './customer-funds.js';
import {
  postCustomerFundsReclassification,
  validateCustomerFundsAccounts,
  validateCustomerFundsPolicy,
} from './customer-funds.js';
import { withCustomerFundsWrite } from './customer-funds-internal.js';
import {
  lockAndReloadInvoice,
  refreshIssuedCreditBalance,
} from './document-money.js';
import { withHistoricalCommerceWrite } from './historical-commerce-internal.js';
import type {
  ApplyHistoricalCustomerFundsInput,
  HistoricalCustomerFundsPolicy,
  HistoricalCustomerFundsPosition,
  HistoricalFundsSnapshot,
  RecordHistoricalCustomerAllocationInput,
  RecordHistoricalCustomerFundsInput,
  RefundHistoricalCustomerFundsInput,
} from './historical-customer-funds-types.js';
import { historicalCreditRefundCommittedTotal } from './historical-funds-internal.js';
import { getHistoricalSalesMoney } from './historical-sales-money.js';
import {
  historicalCalendarDate,
  historicalText,
} from './historical-sales-validation.js';
import { SalesContract } from './models/Contract.js';
import { HistoricalCustomerFunds } from './models/HistoricalCustomerFunds.js';
import { HistoricalCustomerFundsAllocation } from './models/HistoricalCustomerFundsAllocation.js';
import type { Invoice } from './models/Invoice.js';
import { Payment } from './models/Payment.js';
import {
  calculateInvoicePayable,
  parseInvoiceRetention,
} from './retention-money.js';
import { withTenantMoneyRuntime } from './tenant-money-barrier.js';
import { InvoiceStatus, PaymentMethod } from './types/index.js';

function invalid(
  message = 'Historical customer funds require exact reviewed source facts',
): never {
  throw new Error(message);
}
function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function identity(value: unknown) {
  const h = hash(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    invalid();
  return value;
}
function nullableText(value: unknown) {
  return value === null ? null : historicalText(value);
}
function owner(tenantId: string) {
  if (getTenantId() !== tenantId)
    invalid('Historical customer funds require the explicit active tenant');
}
function sum(values: number[]) {
  const total = values.reduce((sum, value) => sum + BigInt(value), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < 0n)
    invalid('Historical customer funds capacity is unsafe');
  return Number(total);
}
function terms(
  input: HistoricalCustomerFundsPolicy,
): HistoricalCustomerFundsPolicy {
  if (
    !input ||
    !['unapplied-ar', 'deposit-liability'].includes(input.mode) ||
    input.taxTiming !== 'invoice-tax-point' ||
    !['any-issued-invoice', 'final-invoice-only'].includes(
      input.releaseEligibility,
    )
  )
    invalid(
      'Historical advances require an explicit supported original deposit and release policy',
    );
  return {
    version: historicalText(input.version),
    mode: input.mode,
    taxTiming: input.taxTiming,
    releaseEligibility: input.releaseEligibility,
  };
}
function snapshotFrom(
  input: RecordHistoricalCustomerFundsInput,
): HistoricalFundsSnapshot {
  if (
    !['receipt', 'refund'].includes(input.kind) ||
    !['magnitudes', 'signed'].includes(input.polarity) ||
    !Number.isSafeInteger(input.originalAmountMinor) ||
    !ISO_4217_MINOR_UNITS.has(input.currency) ||
    ISO_4217_MINOR_UNITS.get(input.currency) === null
  )
    invalid();
  const sign = input.kind === 'refund' && input.polarity === 'signed' ? -1 : 1;
  positive(input.originalAmountMinor * sign);
  const source = input.source;
  const refundSource =
    input.refundSource === null || input.refundSource === undefined
      ? null
      : input.refundSource.kind === 'unallocated-funds'
        ? {
            kind: 'unallocated-funds' as const,
            receiptId: historicalText(input.refundSource.receiptId),
          }
        : input.refundSource.kind === 'issued-credit'
          ? {
              kind: 'issued-credit' as const,
              creditNoteId: historicalText(input.refundSource.creditNoteId),
            }
          : invalid();
  if ((input.kind === 'refund') !== Boolean(refundSource))
    invalid(
      'Historical refunds require exact original funds or issued-credit lineage',
    );
  if (
    !input.accounting ||
    !['externally-recorded', 'source-only'].includes(input.accounting.state)
  )
    invalid();
  return {
    version: 1,
    tenantId: input.tenantId,
    customerId: input.customerId,
    contractId: input.contractId ?? null,
    currency: input.currency,
    origin: 'historical',
    paymentId: null,
    requestId: historicalText(input.requestId),
    evidenceRef: historicalText(input.evidenceRef),
    review: {
      actorId: historicalText(input.review?.actorId),
      policyRef: historicalText(input.review?.policyRef),
    },
    recordedAt: new Date().toISOString(),
    source: {
      namespace: historicalText(source?.namespace),
      key: historicalText(source?.key),
      version: historicalText(source?.version),
      effectiveOn: historicalCalendarDate(source?.effectiveOn),
      depositedOn:
        source?.depositedOn === null
          ? null
          : historicalCalendarDate(source?.depositedOn),
      method: historicalText(source?.method),
      reference: nullableText(source?.reference),
      originalActorRef: nullableText(source?.originalActorRef),
    },
    kind: input.kind,
    polarity: input.polarity,
    originalAmountMinor: input.originalAmountMinor,
    policy: terms(input.policy),
    accounting: {
      state: input.accounting.state,
      ownerRef: nullableText(input.accounting.ownerRef),
      originalJournalRef: nullableText(input.accounting.originalJournalRef),
    },
    refundSource,
  };
}
function amount(snapshot: HistoricalFundsSnapshot) {
  return (
    snapshot.originalAmountMinor *
    (snapshot.kind === 'refund' && snapshot.polarity === 'signed' ? -1 : 1)
  );
}
function sourceHash(snapshot: HistoricalFundsSnapshot) {
  return hash([snapshot.source.namespace, snapshot.source.key]);
}
function stable(snapshot: HistoricalFundsSnapshot) {
  const {
    requestId: _request,
    recordedAt: _recorded,
    review,
    ...facts
  } = snapshot;
  return { ...facts, policyRef: review.policyRef };
}
export function getHistoricalCustomerFundsSnapshot(
  row: HistoricalCustomerFunds,
): HistoricalFundsSnapshot {
  const snapshot = JSON.parse(row.snapshotJson) as HistoricalFundsSnapshot;
  if (
    snapshot.version !== 1 ||
    row.tenantId !== snapshot.tenantId ||
    row.customerId !== snapshot.customerId ||
    row.contractId !== snapshot.contractId ||
    row.currency !== snapshot.currency ||
    row.sourceKeyHash !== sourceHash(snapshot) ||
    row.kind !== snapshot.kind ||
    row.amountMinor !== amount(snapshot) ||
    row.effectiveOn !== snapshot.source.effectiveOn ||
    row.origin !== snapshot.origin ||
    row.paymentId !== snapshot.paymentId ||
    row.sourceReceiptId !==
      (snapshot.refundSource?.kind === 'unallocated-funds'
        ? snapshot.refundSource.receiptId
        : null) ||
    row.sourceCreditNoteId !==
      (snapshot.refundSource?.kind === 'issued-credit'
        ? snapshot.refundSource.creditNoteId
        : null)
  )
    invalid(
      'Historical customer cash no longer matches its immutable original source',
    );
  return structuredClone(snapshot);
}
async function source(db: DatabaseInterface, tenantId: string, id: string) {
  const row = await (
    await HistoricalCustomerFundsCollection.create({ db })
  ).get({ id, tenantId }, { cache: false });
  if (!row)
    invalid(
      'Historical customer funds source is unavailable in the active tenant',
    );
  return { row, snapshot: getHistoricalCustomerFundsSnapshot(row) };
}
async function boundedFunds(
  db: DatabaseInterface,
  where: Record<string, unknown>,
) {
  const rows = await (
    await HistoricalCustomerFundsCollection.create({ db })
  ).list({ where, limit: 100001 });
  if (rows.length > 100000)
    invalid('Historical cash source scope exceeds its bounded limit');
  return rows;
}
async function position(
  db: DatabaseInterface,
  row: HistoricalCustomerFunds,
  snapshot: HistoricalFundsSnapshot,
): Promise<HistoricalCustomerFundsPosition> {
  if (row.kind !== 'receipt')
    invalid('Only original receipts expose available funds');
  const applications = await (
    await HistoricalCustomerFundsAllocationCollection.create({ db })
  ).list({
    where: { tenantId: row.tenantId, receiptId: row.id },
    limit: 100001,
  });
  if (applications.length > 100000) invalid();
  const refunds = await boundedFunds(db, {
    tenantId: row.tenantId,
    sourceReceiptId: row.id,
    kind: 'refund',
  });
  for (const refund of refunds) {
    const original = getHistoricalCustomerFundsSnapshot(refund);
    if (original.origin === 'live') {
      const payment = await (await PaymentCollection.create({ db })).get(
        { id: original.paymentId, tenantId: row.tenantId },
        { cache: false },
      );
      if (
        !payment ||
        payment.status !== 'completed' ||
        payment.kind !== 'refund' ||
        payment.customerId !== row.customerId ||
        payment.currency !== row.currency ||
        payment.amount !== refund.amountMinor ||
        !payment.journalId
      )
        invalid(
          'Current refund evidence no longer matches its journal-backed payment',
        );
    }
  }
  const allocatedMinor = sum(
      applications
        .filter((value) => value.effect === 'payment')
        .map((value) => value.amountMinor),
    ),
    refundedMinor = sum(refunds.map((value) => value.amountMinor));
  const availableMinor = row.amountMinor - allocatedMinor - refundedMinor;
  if (availableMinor < 0)
    invalid('Historical customer funds are over-consumed');
  return {
    receiptId: String(row.id),
    tenantId: row.tenantId,
    customerId: row.customerId,
    contractId: row.contractId,
    currency: row.currency,
    receivedMinor: row.amountMinor,
    allocatedMinor,
    refundedMinor,
    availableMinor,
    receipt: structuredClone(snapshot),
  };
}
export async function getHistoricalCustomerFundsPosition(input: {
  db: DatabaseInterface;
  tenantId: string;
  receiptId: string;
}) {
  owner(input.tenantId);
  return withTenantMoneyRuntime(input.db, input.tenantId, async ({ db }) => {
    const retained = await source(db, input.tenantId, input.receiptId);
    return position(db, retained.row, retained.snapshot);
  });
}
async function creditRefundAvailable(db: DatabaseInterface, credit: Invoice) {
  if (
    credit.kind !== 'credit_note' ||
    !credit.creditedInvoiceId ||
    !credit.moneySnapshotId ||
    credit.status === 'draft' ||
    credit.status === 'cancelled'
  )
    invalid('Historical refund requires an issued original credit note');
  const invoices = await InvoiceCollection.create({ db }),
    original = await invoices.get(
      { id: credit.creditedInvoiceId, tenantId: credit.tenantId },
      { cache: false },
    );
  if (!original) invalid();
  const credits = (
    await invoices
      .list({
        where: { tenantId: credit.tenantId, creditedInvoiceId: original.id },
        limit: 100001,
      })
      .then((rows) => {
        if (rows.length > 100000)
          invalid('Historical credit scope exceeds its bounded source limit');
        return rows;
      })
  ).filter((row) => row.status !== 'draft' && row.status !== 'cancelled');
  if (credits.length > 100000)
    invalid('Credit refund scope exceeds its bounded source limit');
  const allocations = await PaymentAllocationCollection.create({ db }),
    payments = await PaymentCollection.create({ db });
  let already = 0;
  for (const note of credits) {
    already += await historicalCreditRefundCommittedTotal(db, String(note.id));
    for (const allocation of await allocations.findByInvoice(String(note.id))) {
      const payment = await payments.get(
        { id: allocation.paymentId, tenantId: credit.tenantId },
        { cache: false },
      );
      if (payment?.kind === 'refund' && payment.status === 'completed')
        already += allocation.amount;
    }
  }
  const groupAvailable = calculateAvailableRefund({
    sourceTotalMinor: original.totalAmount,
    sourcePaidMinor: original.amountPaid,
    issuedCreditMinor: sum(credits.map((row) => row.totalAmount)),
    settledRefundMinor: already,
  });
  const perCredit =
    credit.totalAmount -
    (await historicalCreditRefundCommittedTotal(db, String(credit.id))) -
    sum(
      (await allocations.findByInvoice(String(credit.id))).map(
        (row) => row.amount,
      ),
    );
  return Math.min(groupAvailable, Math.max(0, perCredit));
}
/** Import original receipt/refund evidence without posting a new cash transaction. */
export async function recordHistoricalCustomerFunds(
  input: RecordHistoricalCustomerFundsInput,
) {
  owner(input.tenantId);
  const snapshot = snapshotFrom(input),
    sourceKeyHash = sourceHash(snapshot),
    amountMinor = amount(snapshot);
  return withTenantMoneyRuntime(input.db, input.tenantId, async ({ db }) => {
    const collection = await HistoricalCustomerFundsCollection.create({ db });
    const existing = (
      await collection.list({
        where: { tenantId: input.tenantId, sourceKeyHash },
        limit: 1,
      })
    )[0];
    if (existing) {
      if (
        existing.customerId !== input.customerId ||
        existing.currency !== input.currency ||
        existing.contractId !== (input.contractId ?? null) ||
        hash(stable(getHistoricalCustomerFundsSnapshot(existing))) !==
          hash(stable(snapshot))
      )
        invalid(
          'Historical cash source identity conflicts with its original facts or reviewed policy',
        );
      return existing;
    }
    if (
      !(await (
        await CustomerCollection.create({ db })
      ).get(
        { id: input.customerId, tenantId: input.tenantId },
        { cache: false },
      ))
    )
      invalid('Historical cash customer is unavailable in the active tenant');
    if (input.contractId) {
      const contract = await (await ContractCollection.create({ db })).get(
        { id: input.contractId, tenantId: input.tenantId },
        { cache: false },
      );
      if (
        !(contract instanceof SalesContract) ||
        contract.customerId !== input.customerId
      )
        invalid('Historical cash contract does not match its customer');
    }
    if (snapshot.refundSource?.kind === 'unallocated-funds') {
      const original = await source(
        db,
        input.tenantId,
        snapshot.refundSource.receiptId,
      );
      if (
        original.row.customerId !== input.customerId ||
        original.row.currency !== input.currency ||
        original.row.contractId !== (input.contractId ?? null) ||
        snapshot.source.effectiveOn < original.row.effectiveOn ||
        amountMinor >
          (await position(db, original.row, original.snapshot)).availableMinor
      )
        invalid(
          'Historical cash refund exceeds matching original unallocated funds',
        );
    }
    if (snapshot.refundSource?.kind === 'issued-credit') {
      const { invoice } = await lockAndReloadInvoice(
        db,
        snapshot.refundSource.creditNoteId,
        input.tenantId,
      );
      if (
        invoice.customerId !== input.customerId ||
        invoice.currency !== input.currency ||
        snapshot.source.effectiveOn <
          invoice.issueDate.toISOString().slice(0, 10) ||
        amountMinor > (await creditRefundAvailable(db, invoice))
      )
        invalid(
          'Historical cash refund exceeds matching issued-credit capacity',
        );
    }
    const row = await new HistoricalCustomerFunds({
      db,
      id: identity({
        tenantId: input.tenantId,
        kind: 'historical-customer-funds',
        sourceKeyHash,
      }),
      tenantId: input.tenantId,
      customerId: historicalText(input.customerId),
      contractId: input.contractId ?? null,
      sourceKeyHash,
      kind: snapshot.kind,
      origin: 'historical',
      paymentId: null,
      currency: input.currency,
      amountMinor,
      effectiveOn: snapshot.source.effectiveOn,
      sourceReceiptId:
        snapshot.refundSource?.kind === 'unallocated-funds'
          ? snapshot.refundSource.receiptId
          : null,
      sourceCreditNoteId:
        snapshot.refundSource?.kind === 'issued-credit'
          ? snapshot.refundSource.creditNoteId
          : null,
      snapshotJson: JSON.stringify(snapshot),
    }).initialize();
    await withHistoricalCommerceWrite(row, () => row.save());
    if (snapshot.refundSource?.kind === 'issued-credit') {
      const { invoice: credit } = await lockAndReloadInvoice(
        db,
        snapshot.refundSource.creditNoteId,
        input.tenantId,
      );
      await updateInvoice(db, credit, true);
    }
    return row;
  });
}

/** Original eligibility is evaluated at the original event date, independently of import order. */
async function historicalAllocationCap(
  db: DatabaseInterface,
  invoice: Invoice,
  effectiveOn: string,
  sameDay: 'credit-before-payment' | 'payment-before-credit' | null,
  cache?: { credits?: Invoice[] },
) {
  const credits =
    cache?.credits ??
    (
      await (
        await InvoiceCollection.create({ db })
      )
        .list({
          where: { tenantId: invoice.tenantId, creditedInvoiceId: invoice.id },
          limit: 100001,
        })
        .then((rows) => {
          if (rows.length > 100000)
            invalid('Historical credit scope exceeds its bounded source limit');
          return rows;
        })
    ).filter((row) => row.status !== 'draft' && row.status !== 'cancelled');
  if (credits.length > 100000)
    invalid('Original credit chronology exceeds its bounded source limit');
  if (cache) cache.credits = credits;
  let credited = 0;
  for (const credit of credits) {
    const on =
      getHistoricalSalesMoney(credit)?.source.issuedOn ??
      credit.issueDate.toISOString().slice(0, 10);
    if (on === effectiveOn && sameDay === null)
      invalid(
        'Same-day original payment/credit chronology requires explicit reviewed ordering',
      );
    if (
      on < effectiveOn ||
      (on === effectiveOn && sameDay === 'credit-before-payment')
    )
      credited += credit.totalAmount;
  }
  const state = parseInvoiceRetention(invoice.retentionStateJson);
  const asOf =
    state && (state.effectiveOn ?? state.recordedAt.slice(0, 10)) <= effectiveOn
      ? {
          ...state,
          releases: state.releases.filter(
            (release) =>
              (release.effectiveOn ?? release.recordedAt.slice(0, 10)) <=
              effectiveOn,
          ),
        }
      : null;
  return calculateInvoicePayable({
    totalAmount: invoice.totalAmount,
    creditedAmount: credited,
    amountPaid: 0,
    currency: invoice.currency,
    retentionStateJson: asOf ? JSON.stringify(asOf) : '',
  }).allocationCapMinor;
}
/** Validate actual application prefixes, never import order or receipt timestamps. */
async function assertHistoricalAllocationPrefixes(
  db: DatabaseInterface,
  invoice: Invoice,
  candidate: ReturnType<typeof allocationRequest>,
) {
  type Order = 'credit-before-payment' | 'payment-before-credit' | null;
  type Event = { on: string; amount: number; order: Order };
  const retained = await (
    await HistoricalCustomerFundsAllocationCollection.create({ db })
  ).list({
    where: {
      tenantId: invoice.tenantId,
      invoiceId: invoice.id,
      effect: 'payment',
    },
    limit: 100001,
  });
  if (retained.length > 100000)
    invalid(
      'Historical allocation chronology exceeds its bounded source limit',
    );
  const events: Event[] = retained.map((row) => {
    const request = JSON.parse(row.snapshotJson).request;
    const order = request.sameDayCreditOrder ?? null;
    if (
      order !== null &&
      order !== 'credit-before-payment' &&
      order !== 'payment-before-credit'
    )
      invalid('Historical allocation ordering evidence is invalid');
    return {
      on: historicalCalendarDate(row.effectiveOn),
      amount: positive(row.amountMinor),
      order,
    };
  });
  // allocatedAt is the public allocation's own "when applied" authority, not a receipt/import date.
  for (const row of await (
    await PaymentAllocationCollection.create({ db })
  ).findByInvoice(String(invoice.id))) {
    const applied = new Date(row.allocatedAt);
    if (
      row.tenantId !== invoice.tenantId ||
      !Number.isFinite(applied.getTime())
    )
      invalid('Current public allocation chronology is unavailable');
    events.push({
      on: applied.toISOString().slice(0, 10),
      amount: positive(row.amount),
      order: null,
    });
  }
  events.push({
    on: candidate.source.effectiveOn,
    amount: candidate.amountMinor,
    order: candidate.sameDayCreditOrder,
  });
  const phase = (order: Order) =>
    order === 'payment-before-credit'
      ? 0
      : order === 'credit-before-payment'
        ? 2
        : 1;
  events.sort(
    (a, b) => a.on.localeCompare(b.on) || phase(a.order) - phase(b.order),
  );
  const cache: { credits?: Invoice[] } = {};
  const caps = new Map<string, number>();
  let prefix = 0n;
  for (const event of events) {
    prefix += BigInt(event.amount);
    if (prefix > BigInt(Number.MAX_SAFE_INTEGER))
      invalid('Historical customer funds capacity is unsafe');
    const key = `${event.on}:${event.order}`;
    let cap = caps.get(key);
    if (cap === undefined) {
      cap = await historicalAllocationCap(
        db,
        invoice,
        event.on,
        event.order,
        cache,
      );
      caps.set(key, cap);
    }
    if (prefix > BigInt(cap))
      invalid(
        'Original cash allocation exceeds payable capacity at an application date',
      );
  }
}
async function updateInvoice(
  db: DatabaseInterface,
  invoice: Invoice,
  historical: boolean,
  effectiveOn?: string,
) {
  const allocations = await PaymentAllocationCollection.create({ db });
  invoice.updatePaymentStatus(
    await allocations.getTotalAllocatedToInvoice(String(invoice.id)),
  );
  if (!historical && effectiveOn && invoice.status === InvoiceStatus.PAID)
    invoice.paidDate = new Date(`${effectiveOn}T00:00:00Z`);
  if (historical) invoice.paidDate = null; // Original cash dates remain explicit allocation facts; import time is not a paid date.
  await invoice.save();
  if (invoice.kind === 'invoice') await refreshIssuedCreditBalance(db, invoice);
  else if (invoice.creditedInvoiceId) {
    const source = await (await InvoiceCollection.create({ db })).get(
      { id: invoice.creditedInvoiceId, tenantId: invoice.tenantId },
      { cache: false },
    );
    if (source) await refreshIssuedCreditBalance(db, source);
  }
}
function releaseEvidence(
  input: CustomerFundsReleaseEvidence | null,
): CustomerFundsReleaseEvidence | null {
  if (input === null) return null;
  if (!input || !['issued-invoice', 'final-invoice'].includes(input.kind))
    invalid('Customer funds require explicit supported release evidence');
  return {
    kind: input.kind,
    invoiceSnapshotId: historicalText(input.invoiceSnapshotId),
    approvalEvidenceRef: historicalText(input.approvalEvidenceRef),
    policyVersion: historicalText(input.policyVersion),
  };
}
function originalAllocationFingerprint(
  request: ReturnType<typeof allocationRequest>,
) {
  const { requestId: _id, review, ...facts } = request;
  return hash({ ...facts, policyRef: review.policyRef });
}
function allocationRequest(input: RecordHistoricalCustomerAllocationInput) {
  const source = {
    namespace: historicalText(input.source?.namespace),
    key: historicalText(input.source?.key),
    version: historicalText(input.source?.version),
    effectiveOn: historicalCalendarDate(input.source?.effectiveOn),
  };
  if (Boolean(input.receiptId) === Boolean(input.creditNoteId))
    invalid(
      'An original application requires exactly one cash receipt or original credit',
    );
  const order = input.sameDayCreditOrder ?? null;
  if (
    order !== null &&
    !['credit-before-payment', 'payment-before-credit'].includes(order)
  )
    invalid('Original same-day credit order must be explicitly reviewed');
  const review = {
    actorId: historicalText(input.review?.actorId),
    policyRef: historicalText(input.review?.policyRef),
  };
  return {
    source,
    amountMinor: positive(input.amountMinor),
    review,
    requestId: historicalText(input.requestId),
    evidenceRef: historicalText(input.evidenceRef),
    receiptId: input.receiptId ?? null,
    creditNoteId: input.creditNoteId ?? null,
    invoiceId: historicalText(input.invoiceId),
    release: releaseEvidence(input.release),
    sameDayCreditOrder: input.sameDayCreditOrder ?? null,
  };
}
/** Preserve a source payment_allocation as a concrete immutable public child. */
export async function recordHistoricalCustomerAllocation(
  input: RecordHistoricalCustomerAllocationInput,
) {
  owner(input.tenantId);
  const request = allocationRequest(input),
    sourceKeyHash = hash([request.source.namespace, request.source.key]);
  return withTenantMoneyRuntime(input.db, input.tenantId, async ({ db }) => {
    const collection = await HistoricalCustomerFundsAllocationCollection.create(
      { db },
    );
    const previous = (
      await collection.list({
        where: { tenantId: input.tenantId, sourceKeyHash },
        limit: 1,
      })
    )[0];
    if (previous) {
      const prior = JSON.parse(previous.snapshotJson);
      if (
        originalAllocationFingerprint(prior.request) !==
        originalAllocationFingerprint(request)
      )
        invalid(
          'Historical application source identity conflicts with its original facts',
        );
      return previous;
    }
    const { invoice } = await lockAndReloadInvoice(
      db,
      request.invoiceId,
      input.tenantId,
    );
    if (
      !invoice.moneySnapshotId ||
      invoice.status === 'draft' ||
      invoice.status === 'cancelled' ||
      request.source.effectiveOn < invoice.issueDate.toISOString().slice(0, 10)
    )
      invalid(
        'Original applications require an already issued matching invoice at their original date',
      );
    let effect: 'payment' | 'credit-audit' | 'refund-audit';
    if (request.creditNoteId) {
      const { invoice: credit } = await lockAndReloadInvoice(
        db,
        request.creditNoteId,
        input.tenantId,
      );
      if (
        credit.kind !== 'credit_note' ||
        credit.creditedInvoiceId !== invoice.id ||
        invoice.kind !== 'invoice' ||
        !credit.moneySnapshotId ||
        credit.status === 'draft' ||
        credit.status === 'cancelled' ||
        credit.customerId !== invoice.customerId ||
        credit.currency !== invoice.currency ||
        request.amountMinor > credit.totalAmount ||
        request.source.effectiveOn < credit.issueDate.toISOString().slice(0, 10)
      )
        invalid(
          'Original credit applications must audit the same issued original-invoice credit effect',
        );
      const existing = await collection.list({
        where: {
          tenantId: input.tenantId,
          creditNoteId: credit.id,
          effect: 'credit-audit',
        },
        limit: 100001,
      });
      if (
        existing.length > 100000 ||
        sum(existing.map((row) => row.amountMinor)) + request.amountMinor >
          credit.totalAmount
      )
        invalid(
          'Original credit audit exceeds its single original economic credit effect',
        );
      if (request.release !== null)
        invalid('A credit audit is not a customer-funds release approval');
      effect = 'credit-audit';
    } else {
      const retained = await source(
        db,
        input.tenantId,
        String(request.receiptId),
      );
      if (
        retained.row.customerId !== invoice.customerId ||
        retained.row.currency !== invoice.currency ||
        (retained.row.contractId &&
          retained.row.contractId !== invoice.contractId) ||
        request.source.effectiveOn < retained.row.effectiveOn
      )
        invalid(
          'Original cash application must match tenant, customer, currency, contract and source chronology',
        );
      if (retained.row.kind === 'receipt') {
        if (
          invoice.kind !== 'invoice' ||
          request.amountMinor >
            (await position(db, retained.row, retained.snapshot)).availableMinor
        )
          invalid(
            'Original application exceeds unallocated historical customer funds',
          );
        const release = request.release;
        if (
          !release ||
          release.invoiceSnapshotId !== invoice.moneySnapshotId ||
          release.policyVersion !== retained.snapshot.policy.version ||
          (retained.snapshot.policy.releaseEligibility ===
            'final-invoice-only' &&
            release.kind !== 'final-invoice') ||
          !release.approvalEvidenceRef
        )
          invalid(
            'Original application requires explicit matching frozen release evidence',
          );
        await assertHistoricalAllocationPrefixes(db, invoice, request);
        effect = 'payment';
      } else {
        if (
          invoice.kind !== 'credit_note' ||
          retained.row.sourceCreditNoteId !== invoice.id ||
          request.release !== null
        )
          invalid(
            'Original refund application must match its exact reserved issued credit',
          );
        const existing = await collection.list({
          where: { tenantId: input.tenantId, receiptId: retained.row.id },
          limit: 100001,
        });
        if (
          existing.length > 100000 ||
          sum(existing.map((row) => row.amountMinor)) + request.amountMinor >
            retained.row.amountMinor
        )
          invalid(
            'Original refund application exceeds its exact reserved cash refund',
          );
        effect = 'refund-audit';
      }
    }
    const snapshot = {
      version: 1,
      origin: 'historical',
      recordedAt: new Date().toISOString(),
      request: { ...request, review: { policyRef: request.review.policyRef } },
      importer: request.review.actorId,
      effect,
      journalId: null,
    };
    const row = await new HistoricalCustomerFundsAllocation({
      db,
      id: identity({
        tenantId: input.tenantId,
        kind: 'historical-customer-allocation',
        sourceKeyHash,
      }),
      tenantId: input.tenantId,
      receiptId: request.receiptId,
      creditNoteId: request.creditNoteId,
      invoiceId: String(invoice.id),
      sourceKeyHash,
      amountMinor: request.amountMinor,
      effectiveOn: request.source.effectiveOn,
      origin: 'historical',
      effect,
      journalId: null,
      snapshotJson: JSON.stringify(snapshot),
    }).initialize();
    await withHistoricalCommerceWrite(row, () => row.save());
    if (effect === 'payment') await updateInvoice(db, invoice, true);
    return row;
  });
}

/** A NEW application uses today's explicit accounts and public reclassification, not a second receipt. */
export async function applyHistoricalCustomerFunds(
  input: ApplyHistoricalCustomerFundsInput,
) {
  owner(input.tenantId);
  const amountMinor = positive(input.amountMinor),
    effectiveOn = historicalCalendarDate(input.effectiveOn),
    requestId = historicalText(input.requestId),
    evidenceRef = historicalText(input.evidenceRef),
    actorId = historicalText(input.actorId),
    currentPolicy = validateCustomerFundsPolicy(input.currentPolicy);
  return withTenantMoneyRuntime(input.db, input.tenantId, async ({ db }) => {
    const retained = await source(db, input.tenantId, input.receiptId);
    const collection = await HistoricalCustomerFundsAllocationCollection.create(
        { db },
      ),
      sourceKeyHash = hash([
        'current-historical-funds',
        input.receiptId,
        requestId,
      ]);
    const request = {
      receiptId: input.receiptId,
      invoiceId: input.invoiceId,
      requestId,
      evidenceRef,
      actorId,
      amountMinor,
      effectiveOn,
      release: input.release,
      currentPolicy,
    };
    const previous = (
      await collection.list({
        where: { tenantId: input.tenantId, sourceKeyHash },
        limit: 1,
      })
    )[0];
    if (previous) {
      if (hash(JSON.parse(previous.snapshotJson).request) !== hash(request))
        invalid('Current application retry differs from its reviewed request');
      return previous;
    }
    if (
      retained.row.kind !== 'receipt' ||
      effectiveOn < retained.row.effectiveOn ||
      amountMinor >
        (await position(db, retained.row, retained.snapshot)).availableMinor
    )
      invalid('Current application exceeds historical unallocated funds');
    if (
      ['mode', 'taxTiming', 'releaseEligibility'].some(
        (key) =>
          currentPolicy[key as keyof HistoricalCustomerFundsPolicy] !==
          retained.snapshot.policy[key as keyof HistoricalCustomerFundsPolicy],
      )
    )
      invalid(
        'Current book mapping cannot change original deposit/release policy terms',
      );
    const { invoice } = await lockAndReloadInvoice(
        db,
        input.invoiceId,
        input.tenantId,
      ),
      release = releaseEvidence(input.release);
    if (
      invoice.kind !== 'invoice' ||
      !invoice.moneySnapshotId ||
      invoice.status === 'draft' ||
      invoice.status === 'cancelled' ||
      invoice.customerId !== retained.row.customerId ||
      invoice.currency !== retained.row.currency ||
      (retained.row.contractId &&
        invoice.contractId !== retained.row.contractId) ||
      !release ||
      release.invoiceSnapshotId !== invoice.moneySnapshotId ||
      release.policyVersion !== retained.snapshot.policy.version ||
      !release.approvalEvidenceRef ||
      (retained.snapshot.policy.releaseEligibility === 'final-invoice-only' &&
        release.kind !== 'final-invoice')
    )
      invalid(
        'Current application does not match its issued invoice and frozen original release policy',
      );
    const allocated = await (
      await PaymentAllocationCollection.create({ db })
    ).getTotalAllocatedToInvoice(String(invoice.id));
    if (allocated + amountMinor > invoice.getPayableFacts().allocationCapMinor)
      invalid(
        'Current customer funds would exceed combined current invoice payable capacity',
      );
    await validateCustomerFundsAccounts(db, input.tenantId, currentPolicy);
    const journalId = await postCustomerFundsReclassification(
      db,
      { id: retained.row.id, currency: retained.row.currency },
      { policy: currentPolicy },
      { requestId, evidenceRef, effectiveOn, amountMinor },
      false,
      'historical-receipt',
    );
    const row = await new HistoricalCustomerFundsAllocation({
      db,
      id: identity({ tenantId: input.tenantId, sourceKeyHash }),
      tenantId: input.tenantId,
      receiptId: input.receiptId,
      creditNoteId: null,
      invoiceId: input.invoiceId,
      sourceKeyHash,
      amountMinor,
      effectiveOn,
      origin: 'live',
      effect: 'payment',
      journalId,
      snapshotJson: JSON.stringify({
        version: 1,
        origin: 'live',
        recordedAt: new Date().toISOString(),
        request,
        effect: 'payment',
        journalId,
      }),
    }).initialize();
    await withHistoricalCommerceWrite(row, () => row.save());
    await updateInvoice(db, invoice, false, effectiveOn);
    return row;
  });
}

/** A NEW refund of original unapplied cash posts exactly once through Payment's owning command. */
export async function refundHistoricalCustomerFunds(
  input: RefundHistoricalCustomerFundsInput,
) {
  owner(input.tenantId);
  const amountMinor = positive(input.amountMinor),
    effectiveOn = historicalCalendarDate(input.effectiveOn),
    requestId = historicalText(input.requestId),
    evidenceRef = historicalText(input.evidenceRef),
    actorId = historicalText(input.actorId),
    currentPolicy = validateCustomerFundsPolicy(input.currentPolicy);
  if (!Object.values(PaymentMethod).includes(input.method))
    invalid('Current refund requires an explicit supported payment method');
  return withTenantMoneyRuntime(input.db, input.tenantId, async ({ db }) => {
    const retained = await source(db, input.tenantId, input.receiptId),
      collection = await HistoricalCustomerFundsCollection.create({ db });
    const sourceKeyHash = hash([
      `live-historical-refund:${input.receiptId}`,
      requestId,
    ]);
    const request = {
      receiptId: input.receiptId,
      requestId,
      evidenceRef,
      actorId,
      amountMinor,
      effectiveOn,
      currentPolicy,
      method: input.method,
    };
    const prior = (
      await collection.list({
        where: { tenantId: input.tenantId, sourceKeyHash },
        limit: 1,
      })
    )[0];
    if (prior) {
      const saved = JSON.parse(prior.snapshotJson);
      if (hash(saved.currentRequest) !== hash(request))
        invalid(
          'Current historical-funds refund retry differs from its original request',
        );
      return {
        refundId: String(prior.id),
        paymentId: saved.paymentId,
        position: await position(db, retained.row, retained.snapshot),
      };
    }
    if (
      retained.row.kind !== 'receipt' ||
      effectiveOn < retained.row.effectiveOn ||
      amountMinor >
        (await position(db, retained.row, retained.snapshot)).availableMinor
    )
      invalid('Current refund exceeds original unallocated historical funds');
    if (
      ['mode', 'taxTiming', 'releaseEligibility'].some(
        (key) =>
          currentPolicy[key as keyof HistoricalCustomerFundsPolicy] !==
          retained.snapshot.policy[key as keyof HistoricalCustomerFundsPolicy],
      )
    )
      invalid('Current refund cannot change original funds policy terms');
    await validateCustomerFundsAccounts(db, input.tenantId, currentPolicy);
    const state: CustomerFundsState = {
      version: 1,
      kind: 'refund',
      policy: currentPolicy,
      sourcePaymentId: null,
      sourceHistoricalReceiptId: input.receiptId,
      requestId,
      evidenceRef,
      actorId,
      effectiveOn,
      requestFingerprint: hash(request),
      recordedAt: new Date().toISOString(),
      operations: [],
    };
    const payment = await new Payment({
      db,
      id: identity({
        tenantId: input.tenantId,
        sourceKeyHash,
        kind: 'historical-funds-current-refund-payment',
      }),
      tenantId: input.tenantId,
      customerId: retained.row.customerId,
      contractId: retained.row.contractId,
      currency: retained.row.currency,
      amount: amountMinor,
      kind: 'refund',
      method: input.method,
      reference: evidenceRef,
      customerFundsJson: JSON.stringify(state),
    }).initialize();
    await withCustomerFundsWrite(payment, async () => {
      await payment.save();
      await payment.recordRefund({
        ledgerId: '',
        cashAccountId: currentPolicy.cashAccountId,
        receivablesAccountId: currentPolicy.receivablesAccountId,
      });
    });
    const snapshot: HistoricalFundsSnapshot & {
      currentRequest: typeof request;
    } = {
      version: 1,
      tenantId: input.tenantId,
      customerId: retained.row.customerId,
      contractId: retained.row.contractId,
      currency: retained.row.currency,
      origin: 'live',
      paymentId: String(payment.id),
      requestId,
      evidenceRef,
      review: { actorId, policyRef: currentPolicy.version },
      recordedAt: new Date().toISOString(),
      source: {
        namespace: `live-historical-refund:${input.receiptId}`,
        key: requestId,
        version: '1',
        effectiveOn,
        depositedOn: null,
        method: input.method,
        reference: evidenceRef,
        originalActorRef: actorId,
      },
      kind: 'refund',
      polarity: 'magnitudes',
      originalAmountMinor: amountMinor,
      policy: terms(currentPolicy),
      accounting: {
        state: 'local-journal',
        ownerRef: input.tenantId,
        originalJournalRef: payment.journalId,
      },
      refundSource: { kind: 'unallocated-funds', receiptId: input.receiptId },
      currentRequest: request,
    };
    const row = await new HistoricalCustomerFunds({
      db,
      id: identity({
        tenantId: input.tenantId,
        sourceKeyHash,
        kind: 'historical-funds-current-refund',
      }),
      tenantId: input.tenantId,
      customerId: retained.row.customerId,
      contractId: retained.row.contractId,
      sourceKeyHash,
      kind: 'refund',
      origin: 'live',
      paymentId: String(payment.id),
      currency: retained.row.currency,
      amountMinor,
      effectiveOn,
      sourceReceiptId: input.receiptId,
      sourceCreditNoteId: null,
      snapshotJson: JSON.stringify(snapshot),
    }).initialize();
    await withHistoricalCommerceWrite(row, () => row.save());
    return {
      refundId: String(row.id),
      paymentId: String(payment.id),
      position: await position(db, retained.row, retained.snapshot),
    };
  });
}
