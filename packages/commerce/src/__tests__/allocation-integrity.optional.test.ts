import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  disableTenancy,
  enableTenancy,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertAllocationParent } from '../allocation-integrity.js';
import { CustomerCollection } from '../collections/CustomerCollection.js';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { PaymentAllocationCollection } from '../collections/PaymentAllocationCollection.js';
import { PaymentCollection } from '../collections/PaymentCollection.js';
import { InvoiceStatus } from '../types/index.js';

const classes = [
  'Customer',
  'Contract',
  'ContractLineItem',
  'Invoice',
  'InvoiceLineItem',
  'Payment',
  'PaymentAllocation',
];
for (const engine of [
  'sqlite',
  ...(isPostgresAvailable() ? ['postgres'] : []),
]) {
  describe(`atomic payment allocations (${engine})`, () => {
    let db: DatabaseInterface;
    let cleanup: () => Promise<void>;
    let payments: PaymentCollection;
    let invoices: InvoiceCollection;
    let allocations: PaymentAllocationCollection;
    let customerId: string;
    beforeEach(async () => {
      if (engine === 'postgres') {
        const isolated = await createIsolatedTestDbFromManifest({
          includeObjects: classes,
        });
        db = isolated.baseDb;
        cleanup = isolated.cleanup;
      } else {
        db = await getTestDatabase({
          type: engine as 'sqlite' | 'duckdb',
          url: ':memory:',
          classes,
        });
        cleanup = async () => {
          await db.close?.();
        };
      }
      payments = await PaymentCollection.create({ db });
      invoices = await InvoiceCollection.create({ db });
      allocations = await PaymentAllocationCollection.create({ db });
      const customers = await CustomerCollection.create({ db });
      customerId = String(
        (await customers.create({ profileId: randomUUID() })).id,
      );
    });
    afterEach(async () => {
      disableTenancy();
      await cleanup?.();
    });
    async function fixtures(amount = 100) {
      const payment = await payments.create({
        customerId,
        amount,
        currency: 'CAD',
      });
      const invoice = await invoices.create({
        status: InvoiceStatus.SENT,
        customerId,
        subtotal: amount,
        totalAmount: amount,
        currency: 'CAD',
      });
      return { payment, invoice };
    }
    it('preserves payment-only deployments without allocation storage', async () => {
      await db.query('DROP TABLE payment_allocations');
      const payment = await payments.create({
        customerId,
        amount: 100,
        currency: 'CAD',
      });
      payment.notes = 'standalone payment';
      await payment.save();
      expect((await payments.get(payment.id))?.notes).toBe(
        'standalone payment',
      );
    });
    it('propagates allocation storage probe errors instead of disabling validation', async () => {
      const { payment } = await fixtures();
      const probe =
        engine === 'postgres'
          ? vi
              .spyOn(db, 'query')
              .mockRejectedValueOnce(new Error('storage probe denied'))
          : vi
              .spyOn(db, 'tableExists')
              .mockRejectedValueOnce(new Error('storage probe denied'));
      try {
        await expect(
          assertAllocationParent(payment, 'payment'),
        ).rejects.toThrow('storage probe denied');
      } finally {
        probe.mockRestore();
      }
    });
    it('rejects mismatched currency and zero-total invoices before a row is committed', async () => {
      const { payment, invoice } = await fixtures();
      invoice.currency = 'USD';
      await invoice.save();
      await expect(
        allocations.create({
          paymentId: payment.id,
          invoiceId: invoice.id,
          amount: 20,
        }),
      ).rejects.toThrow(/currency/);
      invoice.currency = 'CAD';
      invoice.subtotal = 0;
      invoice.totalAmount = 0;
      await invoice.save();
      await expect(
        allocations.create({
          paymentId: payment.id,
          invoiceId: invoice.id,
          amount: 20,
        }),
      ).rejects.toThrow(/over-pay/);
      expect(await allocations.findByPayment(String(payment.id))).toHaveLength(
        0,
      );
    });
    it('requires existing parents, matching customers and safe positive amounts', async () => {
      const { payment, invoice } = await fixtures();
      for (const amount of [
        0,
        -1,
        0.5,
        Number.NaN,
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        await expect(
          allocations.create({
            paymentId: payment.id,
            invoiceId: invoice.id,
            amount,
          }),
        ).rejects.toThrow();
      }
      await expect(
        allocations.create({
          paymentId: payment.id,
          invoiceId: randomUUID(),
          amount: 1,
        }),
      ).rejects.toThrow(/Invoice/);
      await expect(
        allocations.create({
          paymentId: randomUUID(),
          invoiceId: invoice.id,
          amount: 1,
        }),
      ).rejects.toThrow(/Payment/);
      const customers = await CustomerCollection.create({ db });
      invoice.customerId = String(
        (await customers.create({ profileId: randomUUID() })).id,
      );
      await invoice.save();
      await expect(
        allocations.create({
          paymentId: payment.id,
          invoiceId: invoice.id,
          amount: 1,
        }),
      ).rejects.toThrow(/customer/);
    });
    it('checks both owners even in system context and denies another active tenant', async () => {
      enableTenancy();
      const owner = randomUUID();
      const stranger = randomUUID();
      const pair = await withTenant({ tenantId: owner }, async () => {
        const customers = await CustomerCollection.create({ db });
        const customer = await customers.create({ profileId: randomUUID() });
        const payment = await payments.create({
          customerId: customer.id,
          amount: 100,
          currency: 'CAD',
        });
        const invoice = await invoices.create({
          customerId: customer.id,
          subtotal: 100,
          totalAmount: 100,
          currency: 'CAD',
        });
        await allocations.create({
          paymentId: payment.id,
          invoiceId: invoice.id,
          amount: 10,
        });
        return { payment, invoice };
      });
      await expect(
        withTenant({ tenantId: stranger }, () =>
          allocations.create({
            paymentId: pair.payment.id,
            invoiceId: pair.invoice.id,
            amount: 1,
          }),
        ),
      ).rejects.toThrow();
      await expect(
        withSystemContext(async () =>
          allocations.create({
            tenantId: stranger,
            paymentId: pair.payment.id,
            invoiceId: pair.invoice.id,
            amount: 1,
          }),
        ),
      ).rejects.toThrow(/tenant/);
      expect(
        await withTenant({ tenantId: owner }, () =>
          allocations.getTotalAllocatedFromPayment(String(pair.payment.id)),
        ),
      ).toBe(10);
    });
    it('protects committed allocations against parent corrections', async () => {
      const { payment, invoice } = await fixtures();
      await allocations.create({
        paymentId: payment.id,
        invoiceId: invoice.id,
        amount: 60,
      });
      await payment.loadFromId();
      await invoice.loadFromId();
      payment.amount = 59;
      await expect(payment.save()).rejects.toThrow(/committed allocations/);
      payment.amount = 100;
      payment.currency = 'USD';
      await expect(payment.save()).rejects.toThrow(/currency/);
      invoice.currency = 'USD';
      await expect(invoice.save()).rejects.toThrow(/currency/);
      payment.currency = 'CAD';
      payment.notes = 'allowed correction';
      await payment.save();
      invoice.currency = 'CAD';
      invoice.notes = 'allowed correction';
      await invoice.save();
      const customers = await CustomerCollection.create({ db });
      payment.customerId = String(
        (await customers.create({ profileId: randomUUID() })).id,
      );
      await expect(payment.save()).rejects.toThrow(/customer/);
      expect((await payments.get(payment.id))?.amount).toBe(100);
      expect((await invoices.get(invoice.id))?.currency).toBe('CAD');
    });
    it('preserves stale-write rejection after another parent editor saves', async () => {
      const { payment } = await fixtures();
      const other = (await payments.get(payment.id))!;
      other.notes = 'newer edit';
      await other.save();
      payment.notes = 'stale edit';
      await expect(payment.save()).rejects.toThrow(/Revision conflict/);
      expect((await payments.get(payment.id))?.notes).toBe('newer edit');
    });
    it('splits atomically, replays exact stable ids and rejects changed replay', async () => {
      const { payment, invoice } = await fixtures();
      const second = await invoices.create({
        status: InvoiceStatus.SENT,
        customerId,
        currency: 'CAD',
        subtotal: 100,
        totalAmount: 100,
      });
      const input = {
        paymentId: String(payment.id),
        allocations: [
          { id: randomUUID(), invoiceId: String(invoice.id), amount: 40 },
          { id: randomUUID(), invoiceId: String(second.id), amount: 60 },
        ],
      };
      const result = await allocations.allocatePayment(input);
      result[0].notes = 'caller executor remains usable';
      await result[0].save();
      await allocations.allocatePayment(input);
      expect(
        await allocations.getTotalAllocatedFromPayment(String(payment.id)),
      ).toBe(100);
      expect((await invoices.get(invoice.id))?.amountPaid).toBe(40);
      await expect(
        allocations.allocatePayment({
          ...input,
          allocations: [{ ...input.allocations[0], amount: 41 }],
        }),
      ).rejects.toThrow(/replay/);
    });
    it('retries a committed batch when the result read fails without applying twice', async () => {
      const { payment, invoice } = await fixtures();
      const input = {
        paymentId: String(payment.id),
        allocations: [
          { id: randomUUID(), invoiceId: String(invoice.id), amount: 40 },
        ],
      };
      const read = vi
        .spyOn(allocations, 'get')
        .mockRejectedValueOnce(new Error('result read lost'));
      await expect(allocations.allocatePayment(input)).rejects.toThrow(
        'result read lost',
      );
      read.mockRestore();
      await allocations.allocatePayment(input);
      expect(await allocations.findByPayment(String(payment.id))).toHaveLength(
        1,
      );
      expect(
        await allocations.getTotalAllocatedToInvoice(String(invoice.id)),
      ).toBe(40);
    });
    it('rolls the entire split back when a later leg exceeds its cap', async () => {
      const { payment, invoice } = await fixtures();
      const second = await invoices.create({
        status: InvoiceStatus.SENT,
        customerId,
        currency: 'CAD',
        subtotal: 10,
        totalAmount: 10,
      });
      await expect(
        allocations.allocatePayment({
          paymentId: String(payment.id),
          allocations: [
            { id: randomUUID(), invoiceId: String(invoice.id), amount: 40 },
            { id: randomUUID(), invoiceId: String(second.id), amount: 60 },
          ],
        }),
      ).rejects.toThrow(/over-pay/);
      expect(
        await allocations.getTotalAllocatedFromPayment(String(payment.id)),
      ).toBe(0);
      expect((await invoices.get(invoice.id))?.amountPaid).toBe(0);
    });
    it('serializes competing writers without exceeding either parent cap', async () => {
      const { payment, invoice } = await fixtures();
      const results = await Promise.allSettled(
        [1, 2].map(() =>
          allocations.create({
            paymentId: payment.id,
            invoiceId: invoice.id,
            amount: 60,
          }),
        ),
      );
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        await allocations.getTotalAllocatedFromPayment(String(payment.id)),
      ).toBe(60);
    });
    it('compares aggregate caps exactly at the safe-integer boundary', async () => {
      const { payment, invoice } = await fixtures(Number.MAX_SAFE_INTEGER);
      const other = await payments.create({
        customerId,
        amount: 2,
        currency: 'CAD',
      });
      await allocations.create({
        paymentId: payment.id,
        invoiceId: invoice.id,
        amount: Number.MAX_SAFE_INTEGER - 1,
      });
      await expect(
        allocations.create({
          paymentId: other.id,
          invoiceId: invoice.id,
          amount: 2,
        }),
      ).rejects.toThrow(/over-pay/);
      expect(
        await allocations.getTotalAllocatedToInvoice(String(invoice.id)),
      ).toBe(Number.MAX_SAFE_INTEGER - 1);
    });
    it('caps one invoice when different payments compete', async () => {
      const { payment, invoice } = await fixtures();
      const other = await payments.create({
        customerId,
        amount: 100,
        currency: 'CAD',
      });
      const results = await Promise.allSettled(
        [payment, other].map((source) =>
          allocations.create({
            paymentId: source.id,
            invoiceId: invoice.id,
            amount: 60,
          }),
        ),
      );
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        await allocations.getTotalAllocatedToInvoice(String(invoice.id)),
      ).toBe(60);
    });
    if (engine === 'postgres')
      it('rejects stale Repeatable Read snapshots after another allocation commits', async () => {
        const { payment, invoice } = await fixtures();
        let release!: () => void;
        let established!: () => void;
        const ready = new Promise<void>((resolve) => {
          established = resolve;
        });
        const resume = new Promise<void>((resolve) => {
          release = resolve;
        });
        const stale = db.transaction!(async (tx) => {
          await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
          await tx.query('SELECT id FROM payments WHERE id = ?', payment.id);
          established();
          await resume;
          const bound = await PaymentAllocationCollection.create({ db: tx });
          await bound.create({
            paymentId: payment.id,
            invoiceId: invoice.id,
            amount: 60,
          });
        });
        await ready;
        await allocations.create({
          paymentId: payment.id,
          invoiceId: invoice.id,
          amount: 60,
        });
        release();
        await expect(stale).rejects.toThrow();
        expect(
          await allocations.getTotalAllocatedToInvoice(String(invoice.id)),
        ).toBe(60);
      });
    it.each([
      'payment',
      'invoice',
    ])('serializes a %s reduction against an allocation', async (kind) => {
      const { payment, invoice } = await fixtures();
      const mutation = kind === 'payment' ? payment : invoice;
      if (kind === 'payment') payment.amount = 50;
      else {
        invoice.subtotal = 50;
        invoice.totalAmount = 50;
      }
      const results = await Promise.allSettled([
        allocations.create({
          paymentId: payment.id,
          invoiceId: invoice.id,
          amount: 60,
        }),
        mutation.save(),
      ]);
      expect(results.some((result) => result.status === 'rejected')).toBe(true);
      const committed = await allocations.getTotalAllocatedToInvoice(
        String(invoice.id),
      );
      expect(committed).toBeLessThanOrEqual(
        (await payments.get(payment.id))!.amount,
      );
      expect(committed).toBeLessThanOrEqual(
        (await invoices.get(invoice.id))!.totalAmount,
      );
    });
    it('uses the outer transaction executor and rolls allocations and parent revisions back', async () => {
      const { payment, invoice } = await fixtures();
      const revision = payment.updated_at;
      await expect(
        payment.withTransaction(async () => {
          const bound = await PaymentAllocationCollection.create({
            db: payment.db,
          });
          await bound.allocatePayment({
            paymentId: String(payment.id),
            allocations: [
              { id: randomUUID(), invoiceId: String(invoice.id), amount: 30 },
            ],
          });
          throw new Error('outer rollback');
        }),
      ).rejects.toThrow('outer rollback');
      expect(
        await allocations.getTotalAllocatedFromPayment(String(payment.id)),
      ).toBe(0);
      expect((await payments.get(payment.id))?.updated_at).toEqual(revision);
    });
  });
}

// Commerce's declared foreign keys require ON UPDATE CASCADE. DuckDB is
// deliberately rejected by the owning DDL boundary rather than weakening it.
it('rejects unsupported DuckDB allocation schema at the public boundary', async () => {
  await expect(
    getTestDatabase({ type: 'duckdb', url: ':memory:', classes }),
  ).rejects.toThrow(/DuckDB cannot preserve SMRT/);
});
