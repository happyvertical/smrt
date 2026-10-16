import { randomUUID } from 'node:crypto';
import type {
  QuickBooksReceivableReadback,
  QuickBooksReceivableRequest,
} from '@happyvertical/accounting';
import { AccountCollection } from '@happyvertical/smrt-ledgers';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect, vi } from 'vitest';
import { CustomerCollection } from '../../collections/CustomerCollection.js';
import { InvoiceCollection } from '../../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../../collections/InvoiceLineItemCollection.js';
import { PaymentAllocationCollection } from '../../collections/PaymentAllocationCollection.js';
import { PaymentCollection } from '../../collections/PaymentCollection.js';
import { withDocumentMoneyTransaction } from '../../document-money-internal.js';
import {
  loadFrozenInvoiceAccountingSnapshot,
  syncFrozenInvoiceToAccounting,
} from '../../invoice-accounting-sync.js';
import {
  configureInvoiceRetention,
  releaseInvoiceRetention,
} from '../../invoice-retention.js';
import {
  loadRetainedInvoiceAccountingSnapshot,
  readRetainedInvoiceAccountingState,
  reconcileRetainedAccountingStep,
  releaseRetainedInvoiceToAccounting,
  syncRetainedCreditToAccounting,
  syncRetainedInvoiceToAccounting,
  syncRetainedRefundToAccounting,
  toRetainedInvoiceAccountingInput,
} from '../../retention-accounting.js';
import { ensureTenantTaxCodes } from '../../tax/standard-codes.js';
import { InvoiceStatus } from '../../types/index.js';

export async function proveRetentionAccounting(db: DatabaseInterface) {
  const tenantId = randomUUID();
  await ensureTenantTaxCodes(db, tenantId);
  await withTenant({ tenantId }, async () => {
    const invoices = await InvoiceCollection.create({ db }),
      lines = await InvoiceLineItemCollection.create({ db });
    const customer = await (await CustomerCollection.create({ db })).create({});
    const invoice = await invoices.create({
      invoiceNumber: 'RET-1',
      customerId: customer.id!,
      customerExternalId: 'customer-1',
      currency: 'CAD',
    });
    const line = await lines.create({
      invoiceId: invoice.id!,
      quantity: 10500,
      unitPrice: 1,
      description: 'Retained construction work',
    });
    const load = async () => {
      const row = await invoices.get({ id: invoice.id! }, { cache: false });
      if (!row) throw new Error('Missing fixture');
      return row;
    };
    const evidence = {
      requestId: randomUUID(),
      policyVersion: 'policy-1',
      evidenceRef: 'agreement-1',
      actorId: 'reviewer',
      reason: 'Approved retention',
    };
    await configureInvoiceRetention({
      db,
      tenantId,
      invoiceId: invoice.id!,
      currency: 'CAD',
      amountMinor: 1000,
      expectedUpdatedAt: new Date((await load()).updated_at!).toISOString(),
      ...evidence,
      creditPolicy: 'retained-first',
    });
    let row = await load();
    row.status = InvoiceStatus.SENT;
    await row.save();
    const snapshot = row.moneySnapshotId;
    const reviewScope = { db, tenantId, invoiceId: invoice.id! };
    await expect(
      loadFrozenInvoiceAccountingSnapshot(reviewScope),
    ).rejects.toThrow('Unreleased retention');
    const retainedReview =
      await loadRetainedInvoiceAccountingSnapshot(reviewScope);
    expect(retainedReview.moneySnapshotId).toBe(snapshot);
    expect(retainedReview.document.totalAmountMinor).toBe(10500);
    expect(retainedReview.document.lineItems[0].id).toBe(line.id);
    expect((await load()).retentionAccountingStateJson).toBe('');
    await expect(
      loadRetainedInvoiceAccountingSnapshot({
        ...reviewScope,
        tenantId: randomUUID(),
      }),
    ).rejects.toThrow('active tenant');
    const plain = await invoices.create({
      customerId: customer.id!,
      currency: 'CAD',
    });
    await expect(
      loadRetainedInvoiceAccountingSnapshot({
        ...reviewScope,
        invoiceId: plain.id!,
      }),
    ).rejects.toThrow('calculated retained');
    const invoiceMapping = {
      realmId: 'realm-1',
      environment: 'sandbox' as const,
      lines: { [line.id!]: { itemRef: 'item-1', taxCodeRef: 'non-tax' } },
      components: {},
    };
    const preview = await toRetainedInvoiceAccountingInput({
      ...reviewScope,
      mapping: invoiceMapping,
    });
    expect(preview.totalAmount).toBe(105);
    await expect(
      toRetainedInvoiceAccountingInput({
        ...reviewScope,
        mapping: { ...invoiceMapping, lines: {} },
      }),
    ).rejects.toThrow();
    expect((await load()).retentionAccountingStateJson).toBe('');
    const mapping = {
      realmId: 'realm-1',
      environment: 'sandbox' as const,
      version: 'mapping-1',
      reviewEvidenceRef: 'mapping-review',
      accountingBasis: 'accrual' as const,
      taxTiming: 'invoice-tax-point' as const,
      releaseDueDates: 'host-managed' as const,
      currency: 'CAD',
      customerRef: 'customer-1',
      receivablesAccountRef: 'ar',
      retainedAssetAccountRef: 'retained',
      cashAccountRef: 'bank',
    };
    const reads = new Map<string, QuickBooksReceivableReadback>();
    let failApplication = true;
    let releaseGate: Promise<void> | undefined;
    let releaseStarted = () => {};
    const execute = vi.fn(async (request: QuickBooksReceivableRequest) => {
      if (request.input.kind === 'release' && releaseGate) {
        releaseStarted();
        await releaseGate;
      }
      const result: QuickBooksReceivableReadback = {
        externalId: `remote-${reads.size}`,
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
      };
      reads.set(result.externalId, result);
      if (request.input.kind === 'application' && failApplication) {
        failApplication = false;
        throw new Error('Lost application response');
      }
      return result;
    });
    const push = vi.fn(async () => ({
      externalId: 'provider-invoice-1',
      syncedAt: new Date(),
      success: true,
      action: 'created' as const,
    }));
    const creditPush = vi.fn(async () => ({
      externalId: 'provider-credit-1',
      syncedAt: new Date(),
      success: true,
      action: 'created' as const,
    }));
    const provider = {
      type: 'quickbooks' as const,
      invoices: { push } as any,
      creditMemos: { push: creditPush, sync: creditPush },
      receivableTransfers: {
        verifyMapping: vi.fn(async () => ({
          mappingHash: 'verified',
          homeCurrency: 'CAD',
        })),
        execute,
        read: vi.fn(
          async (_request: QuickBooksReceivableRequest, id: string) => {
            const result = reads.get(id);
            if (!result) throw new Error('Missing remote fixture');
            return result;
          },
        ),
      },
    };
    const command = {
      db,
      tenantId,
      invoiceId: invoice.id!,
      provider,
      requestId: 'bundle-1',
      evidenceRef: 'approval-bundle',
      effectiveOn: '2026-10-16',
      mapping,
      invoiceMapping,
    };
    await expect(
      syncFrozenInvoiceToAccounting({ ...command, mapping: invoiceMapping }),
    ).rejects.toThrow('Unreleased retention');
    await expect(
      withTenant({ tenantId: randomUUID() }, () =>
        syncRetainedInvoiceToAccounting(command),
      ),
    ).rejects.toThrow('active tenant');
    await expect(
      withDocumentMoneyTransaction(db, (tx) =>
        syncRetainedInvoiceToAccounting({ ...command, db: tx }),
      ),
    ).rejects.toThrow('caller-owned');
    await expect(syncRetainedInvoiceToAccounting(command)).rejects.toThrow(
      'Lost application',
    );
    row = await load();
    const unresolved = readRetainedInvoiceAccountingState(row)!;
    expect(unresolved.steps.map((s) => s.status)).toEqual([
      'confirmed',
      'unknown',
    ]);
    expect(unresolved.status).toBe('pending');
    expect(push).toHaveBeenCalledTimes(1);
    expect(row.totalAmount).toBe(10500);
    expect(row.moneySnapshotId).toBe(snapshot);
    expect(row.amountPaid).toBe(0);
    await expect(syncRetainedInvoiceToAccounting(command)).rejects.toThrow(
      'unresolved remote owner',
    );
    expect(execute).toHaveBeenCalledTimes(2);
    const unknown = unresolved.steps[1];
    await expect(
      reconcileRetainedAccountingStep({
        ...command,
        stepKey: unknown.key,
        requestId: unknown.request.requestId,
        attemptId: 'stale',
        outcome: { status: 'found', externalId: 'remote-1' },
      }),
    ).rejects.toThrow('owner differs');
    await reconcileRetainedAccountingStep({
      ...command,
      stepKey: unknown.key,
      requestId: unknown.request.requestId,
      attemptId: unknown.attemptId,
      outcome: { status: 'found', externalId: 'remote-1' },
    });
    expect((await syncRetainedInvoiceToAccounting(command)).status).toBe(
      'ready',
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(push).toHaveBeenCalledTimes(1);
    await expect(
      syncRetainedInvoiceToAccounting({ ...command, evidenceRef: 'changed' }),
    ).rejects.toThrow('immutable');
    row = await load();
    row.retentionAccountingStateJson = '';
    await expect(row.save()).rejects.toThrow('managed by provider commands');
    row = await load();
    const release = {
      db,
      tenantId,
      invoiceId: invoice.id!,
      provider,
      ...evidence,
      requestId: 'release-1',
      amountMinor: 300,
      effectiveOn: '2026-10-17',
      dueOn: '2026-10-01',
      expectedUpdatedAt: new Date(row.updated_at!).toISOString(),
    };
    await expect(
      releaseInvoiceRetention({ ...release, currency: 'CAD' }),
    ).rejects.toThrow('Provider-controlled');
    let unblockRelease!: () => void;
    releaseGate = new Promise<void>((resolve) => {
      unblockRelease = resolve;
    });
    const startedRelease = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    const pendingRelease = releaseRetainedInvoiceToAccounting(release);
    await Promise.race([startedRelease, pendingRelease]);
    await expect(
      releaseRetainedInvoiceToAccounting({
        ...release,
        requestId: 'competing-release',
      }),
    ).rejects.toThrow('reconciliation');
    const liveStep = readRetainedInvoiceAccountingState(
      await load(),
    )!.steps.find((step) => step.key === 'release:release-1')!;
    await expect(
      reconcileRetainedAccountingStep({
        ...command,
        stepKey: liveStep.key,
        requestId: liveStep.request.requestId,
        attemptId: liveStep.attemptId,
        outcome: { status: 'absent', evidenceRef: 'not-enough' },
      }),
    ).rejects.toThrow('proven stopped');
    unblockRelease();
    await pendingRelease;
    expect(
      readRetainedInvoiceAccountingState(await load())!.releases[0].dueOn,
    ).toBe('2026-10-01');
    releaseGate = undefined;
    expect((await load()).getPayableFacts()).toMatchObject({
      retainedRemainingMinor: 700,
      releasedMinor: 300,
      currentlyDueMinor: 9800,
    });
    await releaseRetainedInvoiceToAccounting(release);
    expect(execute).toHaveBeenCalledTimes(3);
    await expect(
      releaseRetainedInvoiceToAccounting({ ...release, amountMinor: 301 }),
    ).rejects.toThrow('changed facts');
    const accounts = await AccountCollection.create({ db });
    const cash = await accounts.create({
      number: '1000-retention',
      name: 'Cash',
      type: 'asset',
    });
    const ar = await accounts.create({
      number: '1200-retention',
      name: 'AR',
      type: 'asset',
    });
    const payments = await PaymentCollection.create({ db });
    const allocations = await PaymentAllocationCollection.create({ db });
    const received = await payments.create({
      kind: 'payment',
      customerId: customer.id!,
      currency: 'CAD',
      amount: 9800,
    });
    await received.recordPayment({
      ledgerId: '',
      cashAccountId: cash.id!,
      receivablesAccountId: ar.id!,
    });
    await allocations.allocatePayment({
      paymentId: received.id!,
      allocations: [{ id: randomUUID(), invoiceId: invoice.id!, amount: 9800 }],
    });
    const credit = await invoices.create({
      invoiceNumber: 'CR-1',
      kind: 'credit_note',
      creditedInvoiceId: invoice.id!,
      customerId: customer.id!,
      customerExternalId: 'customer-1',
      currency: 'CAD',
    });
    const creditLine = await lines.create({
      invoiceId: credit.id!,
      creditedLineId: line.id!,
      quantity: 1000,
      unitPrice: 0,
      description: 'Approved credit',
    });
    const issued = await invoices.get({ id: credit.id! }, { cache: false });
    if (!issued) throw new Error('Missing credit');
    issued.status = InvoiceStatus.SENT;
    await issued.save();
    const creditCommand = {
      db,
      tenantId,
      invoiceId: invoice.id!,
      provider,
      creditInvoiceId: credit.id!,
      requestId: 'credit-adjustment-1',
      evidenceRef: 'credit-approval',
      effectiveOn: '2026-10-18',
      creditMapping: {
        ...invoiceMapping,
        lines: {
          [creditLine.id!]: { itemRef: 'item-1', taxCodeRef: 'non-tax' },
        },
      },
    };
    await expect(
      syncFrozenInvoiceToAccounting({
        db,
        tenantId,
        invoiceId: credit.id!,
        provider,
        mapping: creditCommand.creditMapping,
      }),
    ).rejects.toThrow('retained-first accounting adjustment');
    const adjusted = await syncRetainedCreditToAccounting(creditCommand);
    expect(adjusted.credits[0]).toMatchObject({
      retainedMinor: 700,
      appliedMinor: 0,
      committed: true,
    });
    expect(execute).toHaveBeenCalledTimes(5);
    expect(creditPush).toHaveBeenCalledTimes(1);
    await syncRetainedCreditToAccounting(creditCommand);
    expect(execute).toHaveBeenCalledTimes(5);
    row = await load();
    expect(row.getPayableFacts()).toMatchObject({
      retainedRemainingMinor: 0,
      creditedRetentionMinor: 700,
      currentlyDueMinor: 0,
    });
    expect(row.totalAmount).toBe(10500);
    expect(row.moneySnapshotId).toBe(snapshot);
    const providerCredit = await invoices.get(
      { id: credit.id! },
      { cache: false },
    );
    if (!providerCredit) throw new Error('Missing provider credit');
    providerCredit.cancel();
    await expect(providerCredit.save()).rejects.toThrow('explicit reversal');
    const refund = await payments.create({
      kind: 'refund',
      customerId: customer.id!,
      currency: 'CAD',
      amount: 300,
    });
    await refund.recordPayment({
      ledgerId: '',
      cashAccountId: cash.id!,
      receivablesAccountId: ar.id!,
    });
    const [refundAllocation] = await allocations.allocatePayment({
      paymentId: refund.id!,
      allocations: [{ id: randomUUID(), invoiceId: credit.id!, amount: 300 }],
    });
    const refundCommand = {
      db,
      tenantId,
      invoiceId: invoice.id!,
      provider,
      creditInvoiceId: credit.id!,
      paymentId: refund.id!,
      requestId: 'refund-1',
      evidenceRef: 'bank-refund-evidence',
      effectiveOn: '2026-10-18',
    };
    expect(
      (await syncRetainedRefundToAccounting(refundCommand)).refunds[0],
    ).toMatchObject({ amountMinor: 300, committed: true });
    expect(execute).toHaveBeenCalledTimes(7);
    await syncRetainedRefundToAccounting(refundCommand);
    expect(execute).toHaveBeenCalledTimes(7);
    await expect(refundAllocation.delete()).rejects.toThrow(
      'cannot be deleted',
    );
    const frozenRefund = await payments.get(
      { id: refund.id! },
      { cache: false },
    );
    if (!frozenRefund) throw new Error('Missing refund');
    frozenRefund.amount = 301;
    await expect(frozenRefund.save()).rejects.toThrow('immutable');
    await expect(frozenRefund.delete()).rejects.toThrow('cannot be deleted');
    const cannotVoid = await invoices.get({ id: credit.id! }, { cache: false });
    if (!cannotVoid) throw new Error('Missing credit');
    expect(() => cannotVoid.cancel()).toThrow('Cannot cancel');
  });
}
