import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  AccountCollection,
  JournalCollection,
} from '@happyvertical/smrt-ledgers';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { expect, vi } from 'vitest';
import { CustomerCollection } from '../../collections/CustomerCollection.js';
import { InvoiceCollection } from '../../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../../collections/InvoiceLineItemCollection.js';
import { PaymentAllocationCollection } from '../../collections/PaymentAllocationCollection.js';
import { PaymentCollection } from '../../collections/PaymentCollection.js';
import { PaymentIntentCollection } from '../../collections/PaymentIntentCollection.js';
import { PayoutCollection } from '../../collections/PayoutCollection.js';
import {
  allocateCustomerFunds,
  type CustomerFundsPolicy,
  getCustomerFundsFacts,
  recordCustomerFunds,
  refundCustomerFunds,
  reverseCustomerFundsAllocation,
} from '../../customer-funds.js';
import { Payment } from '../../models/Payment.js';
import { PaymentMethod } from '../../types/index.js';

/** Native public commands and ordinary model paths share the same money authority. */
export async function proveCustomerFunds(
  db: DatabaseInterface,
  concurrent = false,
): Promise<void> {
  const tenantId = randomUUID();
  await withTenant({ tenantId }, async () => {
    const customers = await CustomerCollection.create({ db });
    const customer = await customers.create({ name: 'Advance customer' });
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
      name: 'Customer advances',
      type: 'liability',
    });
    const policy: CustomerFundsPolicy = {
      version: 'reviewed-policy-1',
      mode: 'deposit-liability',
      taxTiming: 'invoice-tax-point',
      releaseEligibility: 'final-invoice-only',
      cashAccountId: cash.id!,
      receivablesAccountId: ar.id!,
      liabilityAccountId: liability.id!,
    };
    const base = {
      db,
      tenantId,
      customerId: customer.id!,
      currency: 'CAD',
      amountMinor: 1000,
      method: PaymentMethod.BANK_TRANSFER,
      requestId: randomUUID(),
      evidenceRef: 'bank-receipt',
      actorId: 'reviewer',
      effectiveOn: '2026-10-01',
      policy,
    };
    // Even an internal caller cannot override the reviewed funds calendar date.
    const originalRecord = Payment.prototype.recordPayment;
    const conflictingDate = vi
      .spyOn(Payment.prototype, 'recordPayment')
      .mockImplementationOnce(function (this: Payment, options) {
        return originalRecord.call(this, {
          ...options,
          effectiveOn: '2026-10-02',
        });
      });
    try {
      await expect(recordCustomerFunds(base)).rejects.toThrow(
        'differs from reviewed',
      );
    } finally {
      conflictingDate.mockRestore();
    }
    const receipt = await recordCustomerFunds(base);
    expect(receipt).toMatchObject({
      receivedMinor: 1000,
      allocatedMinor: 0,
      refundedMinor: 0,
      availableMinor: 1000,
    });
    expect((await recordCustomerFunds(base)).paymentId).toBe(receipt.paymentId);
    await expect(
      recordCustomerFunds({ ...base, amountMinor: 1001 }),
    ).rejects.toThrow(/replay/);
    for (const change of [
      { amountMinor: 0 },
      { amountMinor: 0.1 },
      { amountMinor: Number.MAX_SAFE_INTEGER + 1 },
      { currency: 'XYZ' },
      { effectiveOn: '2026-02-30' },
      { policy: { ...policy, taxTiming: 'unknown' as never } },
      { policy: { ...policy, liabilityAccountId: cash.id! } },
    ])
      await expect(
        recordCustomerFunds({ ...base, requestId: randomUUID(), ...change }),
      ).rejects.toThrow();
    const journals = await JournalCollection.create({ db });
    const journal = (await journals.get(receipt.receiptJournalId))!;
    const entries = await journal.getEntries();
    expect(
      entries.map((entry) => [
        entry.accountId,
        entry.debit,
        entry.credit,
        entry.currency,
      ]),
    ).toEqual([
      [cash.id, 1000, 0, 'CAD'],
      [liability.id, 0, 1000, 'CAD'],
    ]);
    expect(new Date(journal.date).toISOString().slice(0, 10)).toBe(
      '2026-10-01',
    );
    const payments = await PaymentCollection.create({ db });
    const source = (await payments.get(
      { id: receipt.paymentId },
      { cache: false },
    ))!;
    expect(new Date(source.paidAt!).toISOString().slice(0, 10)).toBe(
      '2026-10-01',
    );
    source.customerFundsJson = '';
    source.customerId = null;
    await expect(source.save()).rejects.toThrow(/command/);
    await expect(source.delete()).rejects.toThrow(/cannot be deleted/);
    await expect(payments.delete(receipt.paymentId)).rejects.toThrow(
      /cannot be deleted/,
    );
    await expect(
      payments.create({
        tenantId,
        customerId: customer.id!,
        amount: 10,
        customerFundsJson: JSON.stringify(receipt.receipt),
      }),
    ).rejects.toThrow(/command/);
    const intent = await (await PaymentIntentCollection.create({ db })).create({
      offeringRef: 'advance',
      idempotencyKey: randomUUID(),
      paymentOptions: [
        {
          backendId: 'manual',
          currency: 'CAD',
          payTo: 'bank-ref',
          nativeAmount: 1000,
        },
      ],
    });
    await expect(
      intent.verifyAndMarkPaid({
        backendId: 'manual',
        paymentId: receipt.paymentId,
      }),
    ).rejects.toThrow(/Managed customer funds/);
    intent.markPaid({ backendId: 'manual', paymentId: receipt.paymentId });
    await expect(intent.save()).rejects.toThrow(/Managed customer funds/);
    await expect(
      (await PayoutCollection.create({ db })).create({
        paymentId: receipt.paymentId,
        vendorId: 'unused',
        grossAmount: 1000,
        operatorFee: 0,
        supplierNet: 1000,
        currency: 'CAD',
      }),
    ).rejects.toThrow(/Managed customer funds/);
    const invoices = await InvoiceCollection.create({ db });
    const invoice = await invoices.create({
      customerId: customer.id!,
      currency: 'CAD',
    });
    await (await InvoiceLineItemCollection.create({ db })).create({
      invoiceId: invoice.id!,
      description: 'Final work',
      quantity: 1,
      unitPrice: 600,
    });
    await invoice.loadFromId();
    invoice.markSent();
    await invoice.save();
    const allocations = await PaymentAllocationCollection.create({ db });
    await expect(
      allocations.create({
        paymentId: receipt.paymentId,
        invoiceId: invoice.id!,
        amount: 1,
      }),
    ).rejects.toThrow(/command/);
    await expect(
      allocations.allocatePayment({
        paymentId: receipt.paymentId,
        allocations: [{ id: randomUUID(), invoiceId: invoice.id!, amount: 1 }],
      }),
    ).rejects.toThrow(/command/);
    const application = {
      db,
      tenantId,
      paymentId: receipt.paymentId,
      invoiceId: invoice.id!,
      amountMinor: 600,
      requestId: 'apply-1',
      actorId: 'reviewer',
      evidenceRef: 'apply-bank-funds',
      effectiveOn: '2026-10-02',
      release: {
        kind: 'final-invoice' as const,
        invoiceSnapshotId: invoice.moneySnapshotId,
        approvalEvidenceRef: 'immutable-final-approval',
        policyVersion: policy.version,
      },
    };
    await expect(
      allocateCustomerFunds({
        ...application,
        release: { ...application.release, kind: 'issued-invoice' },
      }),
    ).rejects.toThrow(/policy/);
    await expect(
      allocateCustomerFunds({
        ...application,
        release: { ...application.release, invoiceSnapshotId: randomUUID() },
      }),
    ).rejects.toThrow(/snapshot/);
    const applied = await allocateCustomerFunds(application);
    expect(applied).toMatchObject({ allocatedMinor: 600, availableMinor: 400 });
    expect(
      (await allocateCustomerFunds(application)).receipt.operations.length,
    ).toBe(1);
    await expect(
      allocateCustomerFunds({ ...application, amountMinor: 599 }),
    ).rejects.toThrow(/replay/);
    const allocationId = applied.receipt.operations[0].allocationId!;
    const row = (await allocations.get(allocationId))!;
    row.amount = 1;
    await expect(row.save()).rejects.toThrow(/command/);
    await expect(row.delete()).rejects.toThrow(/command/);
    await expect(allocations.removeAllocation(allocationId)).rejects.toThrow(
      /command/,
    );
    const applicationJournal = (await journals.get(
      applied.receipt.operations[0].journalId!,
    ))!;
    expect(
      (await applicationJournal.getEntries()).map((entry) => [
        entry.accountId,
        entry.debit,
        entry.credit,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [liability.id, 600, 0],
        [ar.id, 0, 600],
      ]),
    );
    expect(await applicationJournal.getEntries()).toHaveLength(2);
    const refund = {
      db,
      tenantId,
      paymentId: receipt.paymentId,
      requestId: 'refund-1',
      amountMinor: 400,
      method: PaymentMethod.BANK_TRANSFER,
      actorId: 'reviewer',
      evidenceRef: 'bank-refund',
      effectiveOn: '2026-10-03',
    };
    await expect(
      refundCustomerFunds({ ...refund, amountMinor: 401 }),
    ).rejects.toThrow(/exceeds/);
    const refunded = await refundCustomerFunds(refund);
    expect(refunded).toMatchObject({
      refundedMinor: 400,
      allocatedMinor: 600,
      availableMinor: 0,
    });
    expect((await refundCustomerFunds(refund)).availableMinor).toBe(0);
    await expect(
      refundCustomerFunds({ ...refund, method: PaymentMethod.CASH }),
    ).rejects.toThrow(/replay/);
    expect(
      await allocations.getUnallocatedFromPayment(receipt.paymentId, 1000),
    ).toBe(0);
    const refundPayment = (await payments.get(
      refunded.receipt.operations[1].refundPaymentId!,
    ))!;
    expect(JSON.parse(refundPayment.customerFundsJson).sourcePaymentId).toBe(
      receipt.paymentId,
    );
    expect(
      (await (await journals.get(refundPayment.journalId))!.getEntries()).map(
        (entry) => [entry.accountId, entry.debit, entry.credit],
      ),
    ).toEqual([
      [cash.id, 0, 400],
      [liability.id, 400, 0],
    ]);
    await expect(refundPayment.save()).rejects.toThrow(/command/);
    await expect(refundPayment.delete()).rejects.toThrow(/cannot be deleted/);
    const reverse = {
      db,
      tenantId,
      paymentId: receipt.paymentId,
      allocationRequestId: 'apply-1',
      requestId: 'reverse-1',
      actorId: 'reviewer',
      evidenceRef: 'approved-reversal',
      effectiveOn: '2026-10-04',
    };
    const reversed = await reverseCustomerFundsAllocation(reverse);
    expect(reversed).toMatchObject({
      allocatedMinor: 0,
      refundedMinor: 400,
      availableMinor: 600,
    });
    expect(reversed.receipt.operations).toHaveLength(3);
    expect(reversed.receipt.operations[0]).toEqual(
      applied.receipt.operations[0],
    );
    expect(
      (await reverseCustomerFundsAllocation(reverse)).receipt.operations,
    ).toHaveLength(3);
    await expect(
      reverseCustomerFundsAllocation({
        ...reverse,
        requestId: 'reverse-again',
      }),
    ).rejects.toThrow(/already reversed/);
    expect(
      (await invoices.get({ id: invoice.id! }, { cache: false }))!.amountPaid,
    ).toBe(0);
    const reversalJournal = (await journals.get(
      reversed.receipt.operations[2].journalId!,
    ))!;
    expect(
      (await reversalJournal.getEntries()).map((entry) => [
        entry.accountId,
        entry.debit,
        entry.credit,
      ]),
    ).toEqual([
      [liability.id, 0, 600],
      [ar.id, 600, 0],
    ]);
    const before = await getCustomerFundsFacts({
      db,
      tenantId,
      paymentId: receipt.paymentId,
    });
    await expect(
      db.transaction!(async (tx) => {
        await refundCustomerFunds({
          ...refund,
          db: tx,
          requestId: 'rollback',
          amountMinor: 600,
          effectiveOn: '2026-10-05',
        });
        throw new Error('caller rollback');
      }),
    ).rejects.toThrow('caller rollback');
    expect(
      await getCustomerFundsFacts({
        db,
        tenantId,
        paymentId: receipt.paymentId,
      }),
    ).toEqual(before);
    if (concurrent) {
      const suffix = randomUUID().replaceAll('-', '');
      const trigger = `funds_fault_${suffix}`,
        fn = `funds_fault_fn_${suffix}`,
        seq = `funds_fault_seq_${suffix}`;
      await db.query(`CREATE SEQUENCE ${seq}`);
      await db.query(
        `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${receipt.paymentId}' AND NEW.customer_funds_json LIKE '%pg-write-fault%' THEN PERFORM nextval('${seq}'); RAISE EXCEPTION 'owned customer-funds write fault'; END IF; RETURN NEW; END $$`,
      );
      await db.query(
        `CREATE TRIGGER ${trigger} AFTER UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
      );
      try {
        await expect(
          refundCustomerFunds({
            ...refund,
            requestId: 'pg-write-fault',
            amountMinor: 600,
            effectiveOn: '2026-10-05',
          }),
        ).rejects.toThrow(/owned customer-funds write fault/);
        expect(
          (await db.query(`SELECT is_called FROM ${seq}`)).rows[0].is_called,
        ).toBe(true);
      } finally {
        await db.query(`DROP TRIGGER ${trigger} ON payments`);
        await db.query(`DROP FUNCTION ${fn}()`);
        await db.query(`DROP SEQUENCE ${seq}`);
      }
      expect(
        await getCustomerFundsFacts({
          db,
          tenantId,
          paymentId: receipt.paymentId,
        }),
      ).toEqual(before);
      const results = await Promise.allSettled([
        refundCustomerFunds({
          ...refund,
          requestId: 'race-a',
          amountMinor: 600,
          effectiveOn: '2026-10-05',
        }),
        allocateCustomerFunds({
          ...application,
          requestId: 'race-b',
          amountMinor: 600,
          effectiveOn: '2026-10-05',
        }),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        (
          await getCustomerFundsFacts({
            db,
            tenantId,
            paymentId: receipt.paymentId,
          })
        ).availableMinor,
      ).toBe(0);
    }
    const arReceipt = await recordCustomerFunds({
      ...base,
      requestId: randomUUID(),
      policy: {
        ...policy,
        mode: 'unapplied-ar',
        releaseEligibility: 'any-issued-invoice',
        liabilityAccountId: null,
      },
    });
    expect(
      (
        await (await journals.get(arReceipt.receiptJournalId))!.getEntries()
      ).map((entry) => [entry.accountId, entry.debit, entry.credit]),
    ).toEqual([
      [cash.id, 1000, 0],
      [ar.id, 0, 1000],
    ]);
    const arInvoice = await invoices.create({
      customerId: customer.id!,
      currency: 'CAD',
    });
    await (await InvoiceLineItemCollection.create({ db })).create({
      invoiceId: arInvoice.id!,
      description: 'Ordinary invoice',
      quantity: 1,
      unitPrice: 200,
    });
    await arInvoice.loadFromId();
    arInvoice.markSent();
    await arInvoice.save();
    const arApplied = await allocateCustomerFunds({
      ...application,
      paymentId: arReceipt.paymentId,
      invoiceId: arInvoice.id!,
      amountMinor: 200,
      release: {
        ...application.release,
        kind: 'issued-invoice',
        invoiceSnapshotId: arInvoice.moneySnapshotId,
      },
    });
    expect(arApplied).toMatchObject({
      allocatedMinor: 200,
      availableMinor: 800,
    });
    expect(arApplied.receipt.operations[0].journalId).toBeNull();
    const arReversed = await reverseCustomerFundsAllocation({
      ...reverse,
      paymentId: arReceipt.paymentId,
    });
    expect(arReversed.availableMinor).toBe(1000);
    expect(arReversed.receipt.operations[1].journalId).toBeNull();
    await expect(
      refundCustomerFunds({
        ...refund,
        paymentId: arReceipt.paymentId,
        amountMinor: 1,
      }),
    ).rejects.toThrow(/effective date/);
    const arRefund = await refundCustomerFunds({
      ...refund,
      paymentId: arReceipt.paymentId,
      effectiveOn: '2026-10-05',
      amountMinor: 1000,
    });
    expect(arRefund.availableMinor).toBe(0);
    const arRefundPayment = (await payments.get(
      arRefund.receipt.operations[2].refundPaymentId!,
    ))!;
    expect(
      (await (await journals.get(arRefundPayment.journalId))!.getEntries()).map(
        (entry) => [entry.accountId, entry.debit, entry.credit],
      ),
    ).toEqual([
      [cash.id, 0, 1000],
      [ar.id, 1000, 0],
    ]);
    const foreignTenant = randomUUID();
    await withTenant({ tenantId: foreignTenant }, async () => {
      await expect(
        getCustomerFundsFacts({
          db,
          tenantId: foreignTenant,
          paymentId: receipt.paymentId,
        }),
      ).rejects.toThrow(/unavailable/);
    });
    const creditReceipt = await recordCustomerFunds({
      ...base,
      requestId: randomUUID(),
    });
    const creditSource = await invoices.create({
      customerId: customer.id!,
      currency: 'CAD',
    });
    const creditLine = await (
      await InvoiceLineItemCollection.create({ db })
    ).create({
      invoiceId: creditSource.id!,
      description: 'Credited work',
      quantity: 1,
      unitPrice: 600,
    });
    await creditSource.loadFromId();
    creditSource.markSent();
    await creditSource.save();
    await allocateCustomerFunds({
      ...application,
      paymentId: creditReceipt.paymentId,
      invoiceId: creditSource.id!,
      release: {
        ...application.release,
        invoiceSnapshotId: creditSource.moneySnapshotId,
      },
    });
    const credit = await invoices.create({
      kind: 'credit_note',
      creditedInvoiceId: creditSource.id!,
      customerId: customer.id!,
      currency: 'CAD',
    });
    await (await InvoiceLineItemCollection.create({ db })).create({
      invoiceId: credit.id!,
      creditedLineId: creditLine.id!,
      description: 'Returned work',
      quantity: 1,
      unitPrice: 0,
    });
    await credit.loadFromId();
    credit.markSent();
    await credit.save();
    await expect(
      reverseCustomerFundsAllocation({
        ...reverse,
        paymentId: creditReceipt.paymentId,
      }),
    ).rejects.toThrow(/Issued credit/);
    const anotherCustomer = await customers.create({ name: 'Other customer' });
    await expect(
      recordCustomerFunds({
        ...base,
        requestId: randomUUID(),
        customerId: randomUUID(),
      }),
    ).rejects.toThrow();
    const otherInvoice = await invoices.create({
      customerId: anotherCustomer.id!,
      currency: 'CAD',
    });
    await expect(
      allocateCustomerFunds({
        ...application,
        paymentId: creditReceipt.paymentId,
        invoiceId: otherInvoice.id!,
        requestId: 'foreign-customer',
        amountMinor: 1,
      }),
    ).rejects.toThrow(/does not match/);
    liability.active = false;
    await liability.save();
    await expect(
      recordCustomerFunds({ ...base, requestId: randomUUID() }),
    ).rejects.toThrow(/account/);
  });
}
