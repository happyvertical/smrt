import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  AccountCollection,
  JournalCollection,
} from '@happyvertical/smrt-ledgers';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { expect } from 'vitest';
import { CustomerCollection } from '../../collections/CustomerCollection.js';
import { InvoiceCollection } from '../../collections/InvoiceCollection.js';
import { PaymentAllocationCollection } from '../../collections/PaymentAllocationCollection.js';
import { PaymentCollection } from '../../collections/PaymentCollection.js';
import {
  applyHistoricalCustomerFunds,
  getHistoricalCustomerFundsPosition,
  recordHistoricalCustomerAllocation,
  recordHistoricalCustomerFunds,
  refundHistoricalCustomerFunds,
} from '../../historical-customer-funds.js';
import type { HistoricalCustomerFundsPolicy } from '../../historical-customer-funds-types.js';
import { recordHistoricalSalesMoney } from '../../historical-sales-money.js';
import type { HistoricalSalesRetention } from '../../historical-sales-types.js';
import { PaymentMethod } from '../../types/index.js';

const policy: HistoricalCustomerFundsPolicy = {
  version: 'reviewed-v1',
  mode: 'deposit-liability',
  taxTiming: 'invoice-tax-point',
  releaseEligibility: 'any-issued-invoice',
};
const review = {
  actorId: 'import-recorder',
  policyRef: 'original-book-policy',
};
export async function proveHistoricalCustomerFunds(
  db: DatabaseInterface,
  concurrent = false,
) {
  const tenantId = randomUUID();
  await withTenant({ tenantId }, async () => {
    const customer = await (await CustomerCollection.create({ db })).create({
      name: 'Synthetic original customer',
    });
    const customerId = String(customer.id);
    const invoices = await InvoiceCollection.create({ db });
    async function issued(
      key: string,
      grossMinor: number,
      on: string,
      creditedInvoiceId?: string,
      retention?: HistoricalSalesRetention,
    ) {
      const draft = await invoices.create({
        customerId,
        currency: 'CAD',
        invoiceNumber: key,
        kind: creditedInvoiceId ? 'credit_note' : 'invoice',
        creditedInvoiceId,
      });
      await recordHistoricalSalesMoney({
        db,
        tenantId,
        invoiceId: String(draft.id),
        requestId: key,
        evidenceRef: `source:${key}`,
        review,
        source: {
          namespace: 'invented-cash',
          key,
          version: 'v1',
          issuedOn: on,
          dueOn: null,
          timeZone: 'America/Edmonton',
          approval: null,
          ...(retention ? { retention } : {}),
        },
        facts: {
          kind: creditedInvoiceId ? 'credit_note' : 'invoice',
          currency: 'CAD',
          polarity: 'magnitudes',
          netMinor: grossMinor,
          taxMinor: 0,
          grossMinor,
          taxComponents: null,
          detail: { kind: 'header-only' },
        },
        ...(creditedInvoiceId
          ? {
              creditedSource: {
                invoiceId: creditedInvoiceId,
                moneySnapshotId:
                  (
                    await invoices.get(
                      { id: creditedInvoiceId },
                      { cache: false },
                    )
                  )?.moneySnapshotId ?? '',
              },
            }
          : {}),
      });
      return String(draft.id);
    }
    const invoiceId = await issued('original', 10000, '2020-01-01');
    const receiptInput = {
      db,
      tenantId,
      customerId,
      requestId: 'receipt',
      evidenceRef: 'receipt-original',
      review,
      source: {
        namespace: 'invented-cash',
        key: 'receipt',
        version: 'v1',
        effectiveOn: '2020-01-02',
        depositedOn: null,
        method: 'original-check',
        reference: null,
        originalActorRef: 'source-author',
      },
      kind: 'receipt' as const,
      polarity: 'magnitudes' as const,
      originalAmountMinor: 12000,
      currency: 'CAD',
      policy,
      accounting: {
        state: 'externally-recorded' as const,
        ownerRef: 'original-books',
        originalJournalRef: null,
      },
    };
    const receipt = await recordHistoricalCustomerFunds(receiptInput);
    expect(
      (
        await recordHistoricalCustomerFunds({
          ...receiptInput,
          requestId: 'new-run',
          review: { ...review, actorId: 'other-importer' },
        })
      ).id,
    ).toBe(receipt.id);
    const creditId = await issued('credit', 2000, '2020-02-01', invoiceId);
    const invoice = await invoices.get({ id: invoiceId }, { cache: false });
    if (!invoice?.moneySnapshotId) throw new Error('Missing issued fixture');
    const allocationInput = {
      db,
      tenantId,
      invoiceId,
      receiptId: String(receipt.id),
      requestId: 'allocation',
      evidenceRef: 'allocation-original',
      review,
      source: {
        namespace: 'invented-cash',
        key: 'allocation',
        version: 'v1',
        effectiveOn: '2020-01-02',
      },
      amountMinor: 10000,
      release: {
        kind: 'issued-invoice' as const,
        invoiceSnapshotId: invoice.moneySnapshotId,
        policyVersion: policy.version,
        approvalEvidenceRef: 'original-release',
      },
    };
    await recordHistoricalCustomerAllocation(allocationInput);
    expect(
      (await invoices.get({ id: invoiceId }, { cache: false }))?.amountPaid,
    ).toBe(10000);
    expect(
      (await invoices.get({ id: invoiceId }, { cache: false }))?.paidDate,
    ).toBeNull();
    expect(
      await getHistoricalCustomerFundsPosition({
        db,
        tenantId,
        receiptId: String(receipt.id),
      }),
    ).toMatchObject({
      receivedMinor: 12000,
      allocatedMinor: 10000,
      refundedMinor: 0,
      availableMinor: 2000,
    });
    await recordHistoricalCustomerAllocation({
      db,
      tenantId,
      invoiceId,
      creditNoteId: creditId,
      requestId: 'credit-audit',
      evidenceRef: 'credit-allocation-original',
      review,
      source: {
        namespace: 'invented-cash',
        key: 'credit-allocation',
        version: 'v1',
        effectiveOn: '2020-02-01',
      },
      amountMinor: 2000,
      release: null,
    });
    expect(
      (await invoices.get({ id: invoiceId }, { cache: false }))?.creditedAmount,
    ).toBe(2000);
    const refund = await recordHistoricalCustomerFunds({
      ...receiptInput,
      requestId: 'refund',
      evidenceRef: 'refund-original',
      source: {
        ...receiptInput.source,
        key: 'refund',
        effectiveOn: '2020-02-02',
      },
      kind: 'refund',
      originalAmountMinor: 2000,
      refundSource: { kind: 'issued-credit', creditNoteId: creditId },
    });
    expect(
      (await invoices.get({ id: creditId }, { cache: false }))?.amountPaid,
    ).toBe(2000);
    const refundAllocation = {
      db,
      tenantId,
      invoiceId: creditId,
      receiptId: String(refund.id),
      requestId: 'refund-audit',
      evidenceRef: 'refund-allocation-original',
      review,
      source: {
        namespace: 'invented-cash',
        key: 'refund-allocation',
        version: 'v1',
        effectiveOn: '2020-02-02',
      },
      amountMinor: 2000,
      release: null,
    };
    await recordHistoricalCustomerAllocation(refundAllocation);
    await recordHistoricalCustomerAllocation({
      ...refundAllocation,
      requestId: 'repeat',
    });
    expect(
      await (
        await PaymentAllocationCollection.create({ db })
      ).getTotalAllocatedToInvoice(creditId),
    ).toBe(2000);
    expect(
      (await invoices.get({ id: creditId }, { cache: false }))?.amountPaid,
    ).toBe(2000);
    await expect(
      recordHistoricalCustomerFunds({
        ...receiptInput,
        requestId: 'duplicate-refund',
        source: {
          ...receiptInput.source,
          key: 'extra-refund',
          effectiveOn: '2020-02-03',
        },
        kind: 'refund',
        originalAmountMinor: 1,
        refundSource: { kind: 'issued-credit', creditNoteId: creditId },
      }),
    ).rejects.toThrow();
    expect(
      await (await PaymentCollection.create({ db })).list({}),
    ).toHaveLength(0);
    const accounts = await AccountCollection.create({ db });
    const cash = await accounts.create({
      number: randomUUID(),
      name: 'Cash',
      type: 'asset',
    });
    const ar = await accounts.create({
      number: randomUUID(),
      name: 'AR',
      type: 'asset',
    });
    const liability = await accounts.create({
      number: randomUUID(),
      name: 'Source advance liability',
      type: 'liability',
    });
    const currentPolicy = {
      ...policy,
      cashAccountId: String(cash.id),
      receivablesAccountId: String(ar.id),
      liabilityAccountId: String(liability.id),
    };
    const currentInvoiceId = await issued('current-target', 1000, '2020-03-01');
    const currentInvoice = await invoices.get(
      { id: currentInvoiceId },
      { cache: false },
    );
    if (!currentInvoice?.moneySnapshotId)
      throw new Error('Missing current target');
    const apply = {
      db,
      tenantId,
      receiptId: String(receipt.id),
      invoiceId: currentInvoiceId,
      requestId: 'current-apply',
      evidenceRef: 'reviewed-current-application',
      actorId: 'current-operator',
      effectiveOn: '2026-10-01',
      amountMinor: 1000,
      currentPolicy,
      release: {
        kind: 'issued-invoice' as const,
        invoiceSnapshotId: currentInvoice.moneySnapshotId,
        policyVersion: policy.version,
        approvalEvidenceRef: 'current-release-approval',
      },
    };
    const applied = await applyHistoricalCustomerFunds(apply);
    expect((await applyHistoricalCustomerFunds(apply)).id).toBe(applied.id);
    expect(
      (await invoices.get({ id: currentInvoiceId }, { cache: false }))
        ?.amountPaid,
    ).toBe(1000);
    const currentRefund = {
      db,
      tenantId,
      receiptId: String(receipt.id),
      requestId: 'current-refund',
      evidenceRef: 'current-bank-refund',
      actorId: 'current-operator',
      effectiveOn: '2026-10-02',
      amountMinor: 1000,
      method: PaymentMethod.BANK_TRANSFER,
      currentPolicy,
    };
    const refunded = await refundHistoricalCustomerFunds(currentRefund);
    expect((await refundHistoricalCustomerFunds(currentRefund)).paymentId).toBe(
      refunded.paymentId,
    );
    expect(refunded.position).toMatchObject({
      receivedMinor: 12000,
      allocatedMinor: 11000,
      refundedMinor: 1000,
      availableMinor: 0,
    });
    const journals = await (await JournalCollection.create({ db })).list({});
    expect(journals).toHaveLength(2);
    for (const journal of journals)
      expect(
        (await journal.getEntries()).map((entry) => entry.currency),
      ).toEqual(['CAD', 'CAD']);
    await expect(
      refundHistoricalCustomerFunds({
        ...currentRefund,
        requestId: 'excess',
        amountMinor: 1,
      }),
    ).rejects.toThrow();

    const retainedId = await issued(
      'original-retention',
      10000,
      '2020-01-01',
      undefined,
      {
        retainedMinor: 1000,
        creditPolicy: 'retained-first',
        policyRef: 'reviewed-original-retention',
        effectiveOn: '2020-01-01',
        evidenceRef: 'original-held-evidence',
        originalActorRef: null,
        releases: [
          {
            sourceKey: 'release-1',
            amountMinor: 1000,
            effectiveOn: '2020-02-01',
            evidenceRef: 'original-release-evidence',
            originalActorRef: 'original-reviewer',
          },
        ],
      },
    );
    const retainedInvoice = await invoices.get(
      { id: retainedId },
      { cache: false },
    );
    if (!retainedInvoice?.moneySnapshotId)
      throw new Error('Missing retained fixture');
    const retentionReceipt = await recordHistoricalCustomerFunds({
      ...receiptInput,
      requestId: 'retention-receipt',
      source: {
        ...receiptInput.source,
        key: 'retention-receipt',
        effectiveOn: '2020-01-01',
      },
      originalAmountMinor: 10000,
    });
    const retentionAllocation = {
      db,
      tenantId,
      invoiceId: retainedId,
      receiptId: String(retentionReceipt.id),
      requestId: 'retention-cash',
      evidenceRef: 'original-retention-cash',
      review,
      source: {
        namespace: 'invented-cash',
        key: 'retention-allocation',
        version: 'v1',
        effectiveOn: '2020-01-15',
      },
      amountMinor: 9500,
      release: {
        kind: 'issued-invoice' as const,
        invoiceSnapshotId: retainedInvoice.moneySnapshotId,
        policyVersion: policy.version,
        approvalEvidenceRef: 'original-payment-approval',
      },
    };
    await expect(
      recordHistoricalCustomerAllocation(retentionAllocation),
    ).rejects.toThrow(/cap|retention/);
    await recordHistoricalCustomerAllocation({
      ...retentionAllocation,
      source: { ...retentionAllocation.source, effectiveOn: '2020-02-02' },
    });
    expect(
      (await invoices.get({ id: retainedId }, { cache: false }))?.amountPaid,
    ).toBe(9500);
    // Source ingestion order must not replace original allocation chronology.
    const reverseId = await issued(
      'reverse-retention',
      1000,
      '2020-01-01',
      undefined,
      {
        retainedMinor: 500,
        creditPolicy: 'retained-first',
        policyRef: 'reviewed-retention',
        effectiveOn: '2020-01-01',
        evidenceRef: 'held-source',
        originalActorRef: null,
        releases: [
          {
            sourceKey: 'reverse-release',
            amountMinor: 500,
            effectiveOn: '2020-02-01',
            evidenceRef: 'release-source',
            originalActorRef: null,
          },
        ],
      },
    );
    const reverseReceipt = await recordHistoricalCustomerFunds({
      ...receiptInput,
      requestId: 'reverse-receipt',
      source: {
        ...receiptInput.source,
        key: 'reverse-receipt',
        effectiveOn: '2020-01-01',
      },
      originalAmountMinor: 1200,
    });
    const reverseAllocation = (
      key: string,
      amountMinor: number,
      effectiveOn: string,
    ) => ({
      ...retentionAllocation,
      invoiceId: reverseId,
      receiptId: String(reverseReceipt.id),
      requestId: key,
      source: { ...retentionAllocation.source, key, effectiveOn },
      amountMinor,
      release: {
        ...retentionAllocation.release,
        invoiceSnapshotId: reverseInvoice?.moneySnapshotId ?? '',
      },
    });
    const reverseInvoice = await invoices.get(
      { id: reverseId },
      { cache: false },
    );
    await recordHistoricalCustomerAllocation(
      reverseAllocation('reverse-late', 600, '2020-02-02'),
    );
    await expect(
      recordHistoricalCustomerAllocation(
        reverseAllocation('reverse-invalid-early', 501, '2020-01-15'),
      ),
    ).rejects.toThrow(/cap/);
    if (!db.transaction) throw new Error('Missing prefix transaction fixture');
    await expect(
      db.transaction(async (tx) => {
        await recordHistoricalCustomerAllocation({
          ...reverseAllocation('reverse-rollback', 200, '2020-01-15'),
          db: tx,
        });
        throw new Error('prefix rollback');
      }),
    ).rejects.toThrow('prefix rollback');
    expect(
      (await invoices.get({ id: reverseId }, { cache: false }))?.amountPaid,
    ).toBe(600);
    const reverseEarly = reverseAllocation('reverse-early', 400, '2020-01-15');
    const reverseResult =
      await recordHistoricalCustomerAllocation(reverseEarly);
    expect((await recordHistoricalCustomerAllocation(reverseEarly)).id).toBe(
      reverseResult.id,
    );
    expect(
      (await invoices.get({ id: reverseId }, { cache: false }))?.amountPaid,
    ).toBe(1000);
    await expect(
      recordHistoricalCustomerAllocation(
        reverseAllocation('reverse-overflow', 1, '2020-02-03'),
      ),
    ).rejects.toThrow(/cap/);

    const laterCapId = await issued('later-prefix-cap', 1000, '2020-01-01');
    await issued('later-prefix-credit', 200, '2020-02-01', laterCapId);
    const laterCapInvoice = await invoices.get(
      { id: laterCapId },
      { cache: false },
    );
    const laterCapReceipt = await recordHistoricalCustomerFunds({
      ...receiptInput,
      requestId: 'later-cap-receipt',
      source: {
        ...receiptInput.source,
        key: 'later-cap-receipt',
        effectiveOn: '2020-01-01',
      },
      originalAmountMinor: 1200,
    });
    const laterAllocation = (
      key: string,
      amountMinor: number,
      effectiveOn: string,
    ) => ({
      ...retentionAllocation,
      invoiceId: laterCapId,
      receiptId: String(laterCapReceipt.id),
      requestId: key,
      source: { ...retentionAllocation.source, key, effectiveOn },
      amountMinor,
      release: {
        ...retentionAllocation.release,
        invoiceSnapshotId: laterCapInvoice?.moneySnapshotId ?? '',
      },
    });
    await recordHistoricalCustomerAllocation(
      laterAllocation('later-existing', 600, '2020-03-01'),
    );
    // The candidate fits January, but must not overrun the later March payment prefix after a February credit.
    await expect(
      recordHistoricalCustomerAllocation(
        laterAllocation('later-prefix-overflow', 300, '2020-01-15'),
      ),
    ).rejects.toThrow(/cap/);
    await recordHistoricalCustomerAllocation(
      laterAllocation('later-prefix-valid', 200, '2020-01-15'),
    );
    expect(
      (await invoices.get({ id: laterCapId }, { cache: false }))?.amountPaid,
    ).toBe(800);

    const retainedState = JSON.parse(retainedInvoice.retentionStateJson);
    expect(retainedState.releases[0].effectiveOn).toBe('2020-02-01');
    expect(retainedState.releases[0].recordedAt.startsWith('2020')).toBe(false);

    await expect(
      issued(
        'original-impossible-release-credit',
        500,
        '2020-01-20',
        retainedId,
      ),
    ).rejects.toThrow(/retention release/);
    await expect(
      issued(
        'original-ambiguous-release-credit',
        500,
        '2020-02-01',
        retainedId,
      ),
    ).rejects.toThrow(/explicit reviewed ordering/);
    await issued(
      'original-after-release-credit',
      500,
      '2020-03-01',
      retainedId,
    );
    const orderedId = await issued(
      'original-ordered-retention',
      10000,
      '2020-01-01',
      undefined,
      {
        retainedMinor: 1000,
        creditPolicy: 'retained-first',
        policyRef: 'reviewed-original-retention',
        effectiveOn: '2020-01-01',
        evidenceRef: 'ordered-held-evidence',
        originalActorRef: null,
        releases: [
          {
            sourceKey: 'ordered-release',
            amountMinor: 1000,
            effectiveOn: '2020-02-01',
            sameDayCreditOrder: 'release-before-credit',
            evidenceRef: 'ordered-release-evidence',
            originalActorRef: null,
          },
        ],
      },
    );
    await issued('original-ordered-credit', 500, '2020-02-01', orderedId);
    const manyInvoiceId = await issued(
      'many-live-allocations',
      101,
      '2020-01-01',
    );
    const livePayment = await (await PaymentCollection.create({ db })).create({
      customerId,
      currency: 'CAD',
      amount: 101,
    });
    const allocations = await PaymentAllocationCollection.create({ db });
    await allocations.allocatePayment({
      paymentId: String(livePayment.id),
      allocations: Array.from({ length: 101 }, () => ({
        id: randomUUID(),
        invoiceId: manyInvoiceId,
        amount: 1,
      })),
    });
    expect(await allocations.findByInvoice(manyInvoiceId)).toHaveLength(101);
    expect(
      await allocations.findByPayment(String(livePayment.id)),
    ).toHaveLength(101);
    expect(await allocations.getTotalAllocatedToInvoice(manyInvoiceId)).toBe(
      101,
    );
    await expect(
      allocations.allocatePayment({
        paymentId: String(livePayment.id),
        allocations: [
          { id: randomUUID(), invoiceId: manyInvoiceId, amount: 1 },
        ],
      }),
    ).rejects.toThrow(/over-apply|over-pay/);
    // Public current allocations are still real reservations in the dated combined timeline.
    const mixedReceipt = await recordHistoricalCustomerFunds({
      ...receiptInput,
      requestId: 'mixed-current-receipt',
      source: {
        ...receiptInput.source,
        key: 'mixed-current-receipt',
        effectiveOn: '2020-01-01',
      },
      originalAmountMinor: 1000,
    });
    const manyInvoice = await invoices.get(
      { id: manyInvoiceId },
      { cache: false },
    );
    await expect(
      recordHistoricalCustomerAllocation({
        ...retentionAllocation,
        invoiceId: manyInvoiceId,
        receiptId: String(mixedReceipt.id),
        requestId: 'mixed-current-overflow',
        source: {
          ...retentionAllocation.source,
          key: 'mixed-current-overflow',
          effectiveOn: '2020-01-15',
        },
        amountMinor: 1,
        release: {
          ...retentionAllocation.release,
          invoiceSnapshotId: manyInvoice?.moneySnapshotId ?? '',
        },
      }),
    ).rejects.toThrow(/cap/);
    const conservationReceipt = await recordHistoricalCustomerFunds({
      ...receiptInput,
      requestId: 'conservation-receipt',
      source: { ...receiptInput.source, key: 'conservation-receipt' },
      originalAmountMinor: 1000,
    });
    const conservationInvoiceId = await issued(
      'conservation-target',
      1000,
      '2020-03-01',
    );
    const conservationInvoice = await invoices.get(
      { id: conservationInvoiceId },
      { cache: false },
    );
    if (!conservationInvoice?.moneySnapshotId || !db.transaction)
      throw new Error('Missing transaction fixture');
    const conservationApply = {
      ...apply,
      receiptId: String(conservationReceipt.id),
      invoiceId: conservationInvoiceId,
      requestId: 'conservation-apply',
      amountMinor: 750,
      release: {
        ...apply.release,
        invoiceSnapshotId: conservationInvoice.moneySnapshotId,
      },
    };
    const journalCount = (
      await (await JournalCollection.create({ db })).list({ limit: 1000 })
    ).length;
    await expect(
      db.transaction(async (tx) => {
        await applyHistoricalCustomerFunds({ ...conservationApply, db: tx });
        throw new Error('caller rollback');
      }),
    ).rejects.toThrow('caller rollback');
    expect(
      (
        await getHistoricalCustomerFundsPosition({
          db,
          tenantId,
          receiptId: String(conservationReceipt.id),
        })
      ).availableMinor,
    ).toBe(1000);
    expect(
      (await (await JournalCollection.create({ db })).list({ limit: 1000 }))
        .length,
    ).toBe(journalCount);
    expect(
      (await invoices.get({ id: conservationInvoiceId }, { cache: false }))
        ?.amountPaid,
    ).toBe(0);
    if (concurrent) {
      const results = await Promise.allSettled([
        applyHistoricalCustomerFunds(conservationApply),
        refundHistoricalCustomerFunds({
          ...currentRefund,
          receiptId: String(conservationReceipt.id),
          requestId: 'competing-refund',
          amountMinor: 750,
        }),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1);
      const final = await getHistoricalCustomerFundsPosition({
        db,
        tenantId,
        receiptId: String(conservationReceipt.id),
      });
      expect(final.availableMinor).toBe(250);
      expect(final.allocatedMinor + final.refundedMinor).toBe(750);
    }
    receipt.amountMinor = 1;
    await expect(receipt.save()).rejects.toThrow(/command/);
    await expect(receipt.delete()).rejects.toThrow(/immutable|cannot/);
    await withTenant({ tenantId: randomUUID() }, async () => {
      await expect(
        getHistoricalCustomerFundsPosition({
          db,
          tenantId: randomUUID(),
          receiptId: String(receipt.id),
        }),
      ).rejects.toThrow();
    });
  });
}
