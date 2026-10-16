import { randomUUID } from 'node:crypto';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect } from 'vitest';
import { CustomerCollection } from '../../collections/CustomerCollection.js';
import { InvoiceCollection } from '../../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../../collections/InvoiceLineItemCollection.js';
import { PaymentAllocationCollection } from '../../collections/PaymentAllocationCollection.js';
import { PaymentCollection } from '../../collections/PaymentCollection.js';
import { getInvoiceMoneyFacts } from '../../document-money.js';
import { withDocumentMoneyTransaction } from '../../document-money-internal.js';
import { loadFrozenInvoiceAccountingSnapshot } from '../../invoice-accounting-sync.js';
import {
  configureInvoiceRetention,
  releaseInvoiceRetention,
} from '../../invoice-retention.js';
import { ensureTenantTaxCodes } from '../../tax/standard-codes.js';
import { InvoiceStatus } from '../../types/index.js';

function id(value: string | null | undefined) {
  if (!value) throw new Error('Missing fixture id');
  return value;
}
export async function proveRetention(db: DatabaseInterface) {
  const tenantId = randomUUID();
  await ensureTenantTaxCodes(db, tenantId);
  await withTenant({ tenantId }, async () => {
    const invoices = await InvoiceCollection.create({ db });
    const customer = await (await CustomerCollection.create({ db })).create({});
    const source = await invoices.create({
      customerId: id(customer.id),
      currency: 'CAD',
      dueDate: new Date('2020-01-01'),
    });
    const lines = await InvoiceLineItemCollection.create({ db });
    const sourceLine = await lines.create({
      invoiceId: id(source.id),
      description: 'Retention fixture',
      quantity: 10500,
      unitPrice: 1,
    });
    const load = async () => {
      const row = await invoices.get({ id: id(source.id) }, { cache: false });
      if (!row) throw new Error('Missing invoice');
      return row;
    };
    let row = await load();
    const command = {
      db,
      tenantId,
      invoiceId: id(source.id),
      currency: 'CAD',
      amountMinor: 1000,
      expectedUpdatedAt: new Date(row.updated_at ?? '').toISOString(),
      requestId: randomUUID(),
      policyVersion: 'tenant-retention-v1',
      evidenceRef: 'approval-1',
      effectiveOn: '2026-10-01',
      actorId: 'reviewer',
      reason: 'Approved contract holdback',
      creditPolicy: 'retained-first' as const,
    };
    expect(await configureInvoiceRetention(command)).toMatchObject({
      grossMinor: 10500,
      retainedRemainingMinor: 1000,
      allocationCapMinor: 9500,
    });
    expect(await configureInvoiceRetention(command)).toMatchObject({
      allocationCapMinor: 9500,
    });
    await expect(
      configureInvoiceRetention({ ...command, amountMinor: 999 }),
    ).rejects.toThrow('changed facts');
    row = await load();
    expect(JSON.parse(row.retentionStateJson).effectiveOn).toBe(
      command.effectiveOn,
    );
    await expect(
      configureInvoiceRetention({ ...command, effectiveOn: '2026-10-02' }),
    ).rejects.toThrow('changed facts');
    const evidence = row.retentionStateJson;
    row.retentionStateJson = '';
    await expect(row.save()).rejects.toThrow('Retention state');
    row = await load();
    row.status = InvoiceStatus.SENT;
    await row.save();
    const snapshot = row.moneySnapshotId;
    expect(
      (await getInvoiceMoneyFacts({ db, tenantId, invoiceId: id(source.id) }))
        .payable?.allocationCapMinor,
    ).toBe(9500);
    await expect(
      loadFrozenInvoiceAccountingSnapshot({
        db,
        tenantId,
        invoiceId: id(source.id),
      }),
    ).rejects.toThrow('Unreleased retention');
    row.collectionMethod = 'charge_automatically';
    await expect(row.save()).rejects.toThrow('provider retention contract');

    const allocations = await PaymentAllocationCollection.create({ db });
    const payment = await (await PaymentCollection.create({ db })).create({
      customerId: id(customer.id),
      currency: 'CAD',
      amount: 10500,
    });
    await allocations.allocatePayment({
      paymentId: id(payment.id),
      allocations: [
        { id: randomUUID(), invoiceId: id(source.id), amount: 9500 },
      ],
    });
    await expect(
      allocations.create({
        paymentId: id(payment.id),
        invoiceId: id(source.id),
        amount: 1,
      }),
    ).rejects.toThrow('over-pay');
    row = await load();
    expect(row.getAmountDue()).toBe(0);
    expect(row.getBalance()).toBe(1000);
    expect(row.isOverdue()).toBe(false);
    const release = {
      ...command,
      requestId: randomUUID(),
      amountMinor: 400,
      effectiveOn: '2026-10-20',
      expectedUpdatedAt: new Date(row.updated_at ?? '').toISOString(),
    };
    await expect(
      withDocumentMoneyTransaction(db, async (tx) => {
        await releaseInvoiceRetention({ ...release, db: tx });
        throw new Error('outer rollback');
      }),
    ).rejects.toThrow('outer rollback');
    expect((await load()).retentionStateJson).toBe(evidence);
    expect(await releaseInvoiceRetention(release)).toMatchObject({
      releasedMinor: 400,
      currentlyDueMinor: 400,
      retainedRemainingMinor: 600,
    });
    expect(await releaseInvoiceRetention(release)).toMatchObject({
      releasedMinor: 400,
    });
    expect(
      JSON.parse((await load()).retentionStateJson).releases[0].effectiveOn,
    ).toBe(release.effectiveOn);
    await expect(
      releaseInvoiceRetention({ ...release, effectiveOn: '2026-10-21' }),
    ).rejects.toThrow('changed facts');
    await expect(
      releaseInvoiceRetention({ ...release, amountMinor: 399 }),
    ).rejects.toThrow('changed facts');
    await expect(
      releaseInvoiceRetention({ ...release, requestId: randomUUID() }),
    ).rejects.toThrow('Stale');
    row = await load();
    await expect(
      releaseInvoiceRetention({
        ...release,
        requestId: randomUUID(),
        expectedUpdatedAt: new Date(row.updated_at ?? '').toISOString(),
        amountMinor: 601,
      }),
    ).rejects.toThrow('exceeds');
    await expect(
      withTenant({ tenantId: randomUUID() }, () =>
        releaseInvoiceRetention({ ...release, requestId: randomUUID() }),
      ),
    ).rejects.toThrow('active tenant');
    await expect(
      releaseInvoiceRetention({ ...release, currency: 'USD' }),
    ).rejects.toThrow('currency');
    const credit = await invoices.create({
      kind: 'credit_note',
      creditedInvoiceId: id(source.id),
      customerId: id(customer.id),
      currency: 'CAD',
    });
    await lines.create({
      invoiceId: id(credit.id),
      creditedLineId: id(sourceLine.id),
      description: 'Partial credit',
      quantity: 500,
      unitPrice: 0,
    });
    const issuedCredit = await invoices.get(
      { id: id(credit.id) },
      { cache: false },
    );
    if (!issuedCredit) throw new Error('Missing credit');
    issuedCredit.status = InvoiceStatus.SENT;
    await issuedCredit.save();
    row = await load();
    expect(row.getPayableFacts()).toMatchObject({
      retainedRemainingMinor: 100,
      allocationCapMinor: 9900,
    });
    const cancellable = await invoices.get(
      { id: id(credit.id) },
      { cache: false },
    );
    if (!cancellable) throw new Error('Missing credit');
    cancellable.cancel();
    await cancellable.save();
    row = await load();
    expect(row.getPayableFacts()).toMatchObject({
      retainedRemainingMinor: 600,
      allocationCapMinor: 9900,
    });
    expect(row.moneySnapshotId).toBe(snapshot);
    expect(row.totalAmount).toBe(10500);
    const final = {
      ...release,
      requestId: randomUUID(),
      amountMinor: 600,
      expectedUpdatedAt: new Date(row.updated_at ?? '').toISOString(),
    };
    const finalAllocation = {
      paymentId: id(payment.id),
      allocations: [
        { id: randomUUID(), invoiceId: id(source.id), amount: 1000 },
      ],
    };
    const results = await Promise.allSettled([
      releaseInvoiceRetention(final),
      releaseInvoiceRetention({ ...final, requestId: randomUUID() }),
      allocations.allocatePayment(finalAllocation),
    ]);
    expect(
      results.slice(0, 2).filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    row = await load();
    expect(row.getPayableFacts().retainedRemainingMinor).toBe(0);
    await allocations.allocatePayment(finalAllocation);
    row = await load();
    expect(row.getAmountDue()).toBe(0);
    expect(row.getBalance()).toBe(0);
  });
}
