import { randomUUID } from 'node:crypto';
import type {
  AccountingProvider,
  QuickBooksReceivableReadback,
  QuickBooksReceivableRequest,
} from '@happyvertical/accounting';
import { AccountCollection } from '@happyvertical/smrt-ledgers';
import type { DatabaseInterface } from '@happyvertical/sql';
import { vi } from 'vitest';
import { CustomerCollection } from '../../collections/CustomerCollection.js';
import { InvoiceCollection } from '../../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../../collections/InvoiceLineItemCollection.js';
import { PaymentAllocationCollection } from '../../collections/PaymentAllocationCollection.js';
import { PaymentCollection } from '../../collections/PaymentCollection.js';
import { configureInvoiceRetention } from '../../invoice-retention.js';
import {
  syncRetainedCreditToAccounting,
  syncRetainedInvoiceToAccounting,
} from '../../retention-accounting.js';
import { ensureTenantTaxCodes } from '../../tax/standard-codes.js';
import { InvoiceStatus } from '../../types/index.js';

/** A real settled refund with its credit exported; all provider operations are explicit test ports. */
export async function allocationDeleteReservationFixture(
  db: DatabaseInterface,
  tenantId: string,
) {
  await ensureTenantTaxCodes(db, tenantId);
  const invoices = await InvoiceCollection.create({ db }),
    lines = await InvoiceLineItemCollection.create({ db }),
    payments = await PaymentCollection.create({ db }),
    allocations = await PaymentAllocationCollection.create({ db });
  const customer = await (await CustomerCollection.create({ db })).create({});
  const invoice = await invoices.create({
    customerId: customer.id!,
    customerExternalId: 'customer-delete-race',
    currency: 'CAD',
    invoiceNumber: 'DELETE-RACE',
    issueDate: new Date('2026-10-01T12:00:00Z'),
    dueDate: new Date('2026-11-01T12:00:00Z'),
  });
  const line = await lines.create({
    invoiceId: invoice.id!,
    quantity: 1000,
    unitPrice: 1,
    description: 'Original retained work',
  });
  const current = await invoices.get({ id: invoice.id! }, { cache: false });
  if (!current?.updated_at) throw new Error('Missing invoice revision');
  await configureInvoiceRetention({
    db,
    tenantId,
    invoiceId: invoice.id!,
    currency: 'CAD',
    amountMinor: 100,
    creditPolicy: 'retained-first',
    effectiveOn: '2026-10-01',
    expectedUpdatedAt: new Date(current.updated_at).toISOString(),
    requestId: randomUUID(),
    policyVersion: 'reviewed-retention',
    evidenceRef: 'approved-agreement',
    actorId: 'reviewer',
    reason: 'Explicit retained amount',
  });
  const issued = await invoices.get({ id: invoice.id! }, { cache: false });
  if (!issued) throw new Error('Missing invoice');
  issued.status = InvoiceStatus.SENT;
  await issued.save();
  const mapping = {
    realmId: 'delete-race-realm',
    environment: 'sandbox' as const,
    version: 'reviewed-mapping',
    reviewEvidenceRef: 'mapping-review',
    accountingBasis: 'accrual' as const,
    taxTiming: 'invoice-tax-point' as const,
    releaseDueDates: 'host-managed' as const,
    currency: 'CAD',
    customerRef: 'customer-delete-race',
    receivablesAccountRef: 'ar',
    retainedAssetAccountRef: 'retained',
    cashAccountRef: 'bank',
  };
  const execute = vi.fn(
    async (
      request: QuickBooksReceivableRequest,
    ): Promise<QuickBooksReceivableReadback> => ({
      externalId: randomUUID(),
      syncToken: '0',
      kind: request.input.kind,
      customerRef: mapping.customerRef,
      currency: 'CAD',
      effectiveOn: request.input.effectiveOn,
      amountMinor: request.input.amountMinor,
      nonCashAppliedMinor:
        request.input.kind === 'application' ? request.input.amountMinor : 0,
      recordedCashChangeMinor: 0,
      providerProcessedCashMinor: 0,
      bankSettlementVerified: false,
      source: request.input.source,
      payloadHash: request.payloadHash,
    }),
  );
  const push = vi.fn(async () => ({
    externalId: randomUUID(),
    syncedAt: new Date(),
    success: true,
    action: 'created' as const,
  }));
  const creditPush = vi.fn(async () => ({
    externalId: randomUUID(),
    syncedAt: new Date(),
    success: true,
    action: 'created' as const,
  }));
  const unexpected = vi.fn(async () => {
    throw new Error('Unexpected provider operation');
  });
  const invoicePort: AccountingProvider['invoices'] = {
    push,
    sync: push,
    pull: unexpected,
    list: unexpected,
    send: unexpected,
    void: unexpected,
  };
  const provider = {
    type: 'quickbooks' as const,
    invoices: invoicePort,
    creditMemos: { push: creditPush, sync: creditPush },
    receivableTransfers: {
      verifyMapping: vi.fn(async () => ({
        mappingHash: 'verified',
        homeCurrency: 'CAD',
      })),
      execute,
      read: vi.fn(async () => {
        throw new Error('Unexpected readback');
      }),
    },
  };
  const invoiceMapping = {
    realmId: mapping.realmId,
    environment: mapping.environment,
    lines: { [line.id!]: { itemRef: 'item', taxCodeRef: 'non-tax' } },
    components: {},
  };
  const scope = { db, tenantId, invoiceId: invoice.id!, provider };
  await syncRetainedInvoiceToAccounting({
    ...scope,
    requestId: 'original-export',
    evidenceRef: 'approved-original-export',
    effectiveOn: '2026-10-01',
    mapping,
    invoiceMapping,
  });
  const accounts = await AccountCollection.create({ db }),
    cash = await accounts.create({
      number: '1000-delete',
      name: 'Cash',
      type: 'asset',
    }),
    ar = await accounts.create({
      number: '1200-delete',
      name: 'AR',
      type: 'asset',
    });
  const paid = await payments.create({
    customerId: customer.id!,
    currency: 'CAD',
    amount: 900,
  });
  const posting = {
    ledgerId: '',
    cashAccountId: cash.id!,
    receivablesAccountId: ar.id!,
    effectiveOn: '2026-10-01',
  };
  await paid.recordPayment(posting);
  await allocations.allocatePayment({
    paymentId: paid.id!,
    allocations: [{ id: randomUUID(), invoiceId: invoice.id!, amount: 900 }],
  });
  const credit = await invoices.create({
    kind: 'credit_note',
    creditedInvoiceId: invoice.id!,
    customerId: customer.id!,
    customerExternalId: mapping.customerRef,
    currency: 'CAD',
    invoiceNumber: 'DELETE-CREDIT',
    issueDate: new Date('2026-10-02T12:00:00Z'),
    dueDate: new Date('2026-10-02T12:00:00Z'),
  });
  const creditLine = await lines.create({
    invoiceId: credit.id!,
    creditedLineId: line.id!,
    quantity: 200,
    unitPrice: 0,
    description: 'Approved credit',
  });
  const issuedCredit = await invoices.get({ id: credit.id! }, { cache: false });
  if (!issuedCredit) throw new Error('Missing credit');
  issuedCredit.status = InvoiceStatus.SENT;
  await issuedCredit.save();
  await syncRetainedCreditToAccounting({
    ...scope,
    creditInvoiceId: credit.id!,
    requestId: 'credit-export',
    evidenceRef: 'approved-credit',
    effectiveOn: '2026-10-02',
    creditMapping: {
      ...invoiceMapping,
      lines: { [creditLine.id!]: { itemRef: 'item', taxCodeRef: 'non-tax' } },
    },
  });
  const refund = await payments.create({
    kind: 'refund',
    customerId: customer.id!,
    currency: 'CAD',
    amount: 100,
  });
  await refund.recordRefund({ ...posting, effectiveOn: '2026-10-03' });
  const [allocation] = await allocations.allocatePayment({
    paymentId: refund.id!,
    allocations: [{ id: randomUUID(), invoiceId: credit.id!, amount: 100 }],
  });
  return {
    invoices,
    payments,
    allocations,
    allocation,
    refund,
    execute,
    command: {
      ...scope,
      paymentId: refund.id!,
      creditInvoiceId: credit.id!,
      requestId: 'refund-recording',
      evidenceRef: 'settled-bank-refund',
      effectiveOn: '2026-10-03',
    },
  };
}
