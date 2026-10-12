import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  describe(`undelivered invoice allocation (${engine})`, () => {
    let db: DatabaseInterface;
    let cleanup: () => Promise<void>;
    beforeEach(async () => {
      if (engine === 'postgres') {
        const isolated = await createIsolatedTestDbFromManifest({
          includeObjects: classes,
        });
        db = isolated.baseDb;
        cleanup = isolated.cleanup;
      } else {
        db = await getTestDatabase({
          type: 'sqlite',
          url: ':memory:',
          classes,
        });
        cleanup = async () => {
          await db.close?.();
        };
      }
      enableTenancy();
    });
    afterEach(async () => {
      disableTenancy();
      await cleanup?.();
    });
    function owned(run: () => Promise<void>) {
      return withTenant({ tenantId: randomUUID() }, run);
    }
    async function fixture() {
      const invoices = await InvoiceCollection.create({ db });
      const payments = await PaymentCollection.create({ db });
      const allocations = await PaymentAllocationCollection.create({ db });
      const customer = await (await CustomerCollection.create({ db })).create({
        profileId: randomUUID(),
      });
      const invoice = await invoices.create({
        customerId: customer.id,
        currency: 'CAD',
        subtotal: 100,
        totalAmount: 100,
      });
      const payment = await payments.create({
        customerId: customer.id,
        currency: 'CAD',
        amount: 100,
      });
      const input = {
        paymentId: payment.id!,
        allocations: [
          { id: randomUUID(), invoiceId: invoice.id!, amount: 100 },
        ],
      };
      async function reverse() {
        await invoice.loadFromId();
        await invoice.withTransaction(async () => {
          const scoped = await PaymentAllocationCollection.create({
            db: invoice.db,
          });
          for (const row of await scoped.findByInvoice(invoice.id!))
            await row.delete();
          invoice.updatePaymentStatus(0);
          await invoice.save();
        });
        await invoice.loadFromId();
      }
      return {
        invoices,
        payments,
        allocations,
        invoice,
        payment,
        input,
        reverse,
      };
    }
    it('allocates a split to drafts, completes and replays without delivery evidence', () =>
      owned(async () => {
        const f = await fixture();
        const second = await f.invoices.create({
          customerId: f.invoice.customerId,
          currency: 'CAD',
          subtotal: 50,
          totalAmount: 50,
        });
        const split = {
          paymentId: f.payment.id!,
          allocations: [
            { ...f.input.allocations[0], amount: 50 },
            { id: randomUUID(), invoiceId: second.id!, amount: 50 },
          ],
        };
        await f.allocations.allocatePayment(split);
        await f.invoice.loadFromId();
        await second.loadFromId();
        expect(f.invoice.status).toBe(InvoiceStatus.PARTIAL);
        expect(second.status).toBe(InvoiceStatus.PAID);
        const paidDate = String(second.paidDate);
        await f.allocations.allocatePayment(split);
        await second.loadFromId();
        expect(String(second.paidDate)).toBe(paidDate);
        const final = await f.payments.create({
          customerId: f.invoice.customerId,
          currency: 'CAD',
          amount: 50,
        });
        await f.allocations.allocatePayment({
          paymentId: final.id!,
          allocations: [
            { id: randomUUID(), invoiceId: f.invoice.id!, amount: 50 },
          ],
        });
        await f.invoice.loadFromId();
        expect(f.invoice.amountPaid).toBe(100);
        expect(f.invoice.status).toBe(InvoiceStatus.PAID);
        for (const invoice of [f.invoice, second]) {
          expect(invoice.sentAt).toBeNull();
          expect(invoice.viewedAt).toBeNull();
        }
      }));
    it.each([
      40, 100,
    ])('reverses %s allocated units to an undelivered draft', (amount) =>
      owned(async () => {
        const f = await fixture();
        await f.allocations.allocatePayment({
          ...f.input,
          allocations: [{ ...f.input.allocations[0], amount }],
        });
        await f.reverse();
        expect(f.invoice.status).toBe(InvoiceStatus.DRAFT);
        expect(f.invoice.amountPaid).toBe(0);
        expect(f.invoice.paidDate).toBeNull();
        expect(f.invoice.sentAt).toBeNull();
        expect(f.invoice.viewedAt).toBeNull();
        await f.invoice.save();
      }));
    it.each([
      40, 100,
    ])('rejects forged draft hiding %s allocated units', (amount) =>
      owned(async () => {
        const f = await fixture();
        await f.allocations.allocatePayment({
          ...f.input,
          allocations: [{ ...f.input.allocations[0], amount }],
        });
        await f.invoice.loadFromId();
        f.invoice.status = InvoiceStatus.DRAFT;
        f.invoice.amountPaid = 0;
        await expect(f.invoice.save()).rejects.toThrow(/DRAFT requires zero/);
        await f.invoice.loadFromId();
        expect(f.invoice.amountPaid).toBe(amount);
      }));
    it.each([
      InvoiceStatus.PARTIAL,
      InvoiceStatus.PAID,
    ])('rejects forged %s with no allocation', (status) =>
      owned(async () => {
        const f = await fixture();
        f.invoice.status = status;
        f.invoice.amountPaid = 100;
        await expect(f.invoice.save()).rejects.toThrow(/derived amountPaid/);
      }));
    it('preserves delivered provenance on reversal and rejects erased dates', () =>
      owned(async () => {
        const f = await fixture();
        f.invoice.markSent();
        await f.invoice.save();
        await f.allocations.allocatePayment(f.input);
        await f.invoice.loadFromId();
        await expect(
          f.invoice.withTransaction(async () => {
            const scoped = await PaymentAllocationCollection.create({
              db: f.invoice.db,
            });
            for (const row of await scoped.findByInvoice(f.invoice.id!))
              await row.delete();
            f.invoice.sentAt = null;
            f.invoice.viewedAt = null;
            f.invoice.updatePaymentStatus(0);
            await expect(f.invoice.save()).rejects.toThrow(
              /persisted invoice delivery history/,
            );
            // Force rollback of allocation deletion as well; never commit a caught inner failure.
            throw new Error('rollback forged reversal');
          }),
        ).rejects.toThrow('rollback forged reversal');
        await f.invoice.loadFromId();
        expect(f.invoice.amountPaid).toBe(100);
        await f.reverse();
        expect(f.invoice.status).toBe(InvoiceStatus.SENT);
        expect(f.invoice.sentAt).not.toBeNull();
      }));
    it('rolls back allocation/status writes then retries stable ids', () =>
      owned(async () => {
        const f = await fixture();
        const revision = String(f.invoice.updated_at);
        await expect(
          f.payment.withTransaction(async () => {
            await (
              await PaymentAllocationCollection.create({ db: f.payment.db })
            ).allocatePayment(f.input);
            throw new Error('interrupted');
          }),
        ).rejects.toThrow('interrupted');
        await f.invoice.loadFromId();
        expect(f.invoice.status).toBe(InvoiceStatus.DRAFT);
        expect(String(f.invoice.updated_at)).toBe(revision);
        expect(
          await f.allocations.count({ where: { paymentId: f.payment.id } }),
        ).toBe(0);
        await f.allocations.allocatePayment(f.input);
        await f.invoice.loadFromId();
        expect(f.invoice.status).toBe(InvoiceStatus.PAID);
      }));
    it('racing batches never allocate above the undelivered invoice total', () =>
      owned(async () => {
        const f = await fixture();
        const other = await f.payments.create({
          customerId: f.invoice.customerId,
          currency: 'CAD',
          amount: 100,
        });
        const results = await Promise.allSettled([
          f.allocations.allocatePayment(f.input),
          f.allocations.allocatePayment({
            paymentId: other.id!,
            allocations: [
              { id: randomUUID(), invoiceId: f.invoice.id!, amount: 100 },
            ],
          }),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        await f.invoice.loadFromId();
        expect(f.invoice.amountPaid).toBe(100);
        expect(f.invoice.sentAt).toBeNull();
      }));
    it.each([
      InvoiceStatus.CANCELLED,
      InvoiceStatus.WRITTEN_OFF,
    ])('cannot reopen terminal %s as draft', (status) =>
      owned(async () => {
        const f = await fixture();
        f.invoice.status = status;
        await f.invoice.save();
        f.invoice.updatePaymentStatus(0);
        expect(f.invoice.status).toBe(status);
        f.invoice.status = InvoiceStatus.DRAFT;
        await expect(f.invoice.save()).rejects.toThrow(
          /illegal status transition/,
        );
      }));
  });
}
