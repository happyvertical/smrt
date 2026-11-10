import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CustomerCollection } from '../collections/CustomerCollection.js';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { PaymentAllocationCollection } from '../collections/PaymentAllocationCollection.js';
import { PaymentCollection } from '../collections/PaymentCollection.js';
import { InvoiceStatus } from '../types/index.js';
import { createV2Invoice } from './helpers/v2-tenant.js';

const classes = [
  'Customer',
  'Contract',
  'ContractLineItem',
  'Invoice',
  'InvoiceLineItem',
  'Payment',
  'PaymentAllocation',
  // Money-v2 aggregate persistence (#4021).
  'DocumentTax',
  'TaxCode',
  'TaxComponent',
  'TaxSettings',
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
        const baseUrl = process.env.DATABASE_URL;
        if (!baseUrl) throw new Error('PostgreSQL tests require DATABASE_URL');
        const admin = await getTestDatabase({
          type: 'postgres',
          url: baseUrl,
          classes: [],
        });
        const schema = `invoice_undelivered_${randomUUID().replaceAll('-', '')}`;
        let owned: DatabaseInterface | undefined;
        cleanup = async () => {
          try {
            await owned?.close?.();
          } finally {
            try {
              await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
            } finally {
              await admin.close?.();
            }
          }
        };
        try {
          await admin.query(`CREATE SCHEMA "${schema}"`);
          const url = new URL(baseUrl);
          const options = url.searchParams.get('options');
          url.searchParams.set(
            'options',
            `${options ? `${options} ` : ''}-c search_path=${schema}`,
          );
          owned = await getTestDatabase({
            type: 'postgres',
            url: url.toString(),
            classes,
          });
          db = owned;
          expect(
            (await db.query('SELECT current_schema() AS name')).rows[0].name,
          ).toBe(schema);
        } catch (error) {
          await cleanup();
          cleanup = async () => {};
          throw error;
        }
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
      // An undelivered draft whose total comes from its one line (#4021).
      const invoice = await createV2Invoice(db, {
        invoiceNumber: `INV-${randomUUID()}`,
        customerId: String(customer.id),
        currency: 'CAD',
        lines: [100],
        draft: true,
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
        const second = await createV2Invoice(db, {
          invoiceNumber: `INV-${randomUUID()}`,
          customerId: f.invoice.customerId,
          currency: 'CAD',
          lines: [50],
          draft: true,
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
    it.each([
      40, 100,
    ])('reverses viewed-only payment history (%s units)', (amount) =>
      owned(async () => {
        const f = await fixture();
        await f.allocations.allocatePayment({
          ...f.input,
          allocations: [{ ...f.input.allocations[0], amount }],
        });
        await f.invoice.loadFromId();
        f.invoice.markViewed();
        await f.invoice.save();
        const viewedAt = String(f.invoice.viewedAt);
        expect(f.invoice.sentAt).toBeNull();
        await f.reverse();
        expect(f.invoice.status).toBe(InvoiceStatus.VIEWED);
        expect(f.invoice.amountPaid).toBe(0);
        expect(f.invoice.paidDate).toBeNull();
        expect(f.invoice.sentAt).toBeNull();
        expect(String(f.invoice.viewedAt)).toBe(viewedAt);
      }));
    it.each([
      [40, false],
      [100, false],
      [40, true],
      [100, true],
    ] as const)('sends a prepaid invoice without losing payment progress (%s, viewed=%s)', (amount, viewed) =>
      owned(async () => {
        const f = await fixture();
        await f.allocations.allocatePayment({
          ...f.input,
          allocations: [{ ...f.input.allocations[0], amount }],
        });
        await f.invoice.loadFromId();
        if (viewed) {
          f.invoice.markViewed();
          await f.invoice.save();
        }
        const status = f.invoice.status;
        const viewedAt = String(f.invoice.viewedAt);
        const paidDate = String(f.invoice.paidDate);
        f.invoice.markSent();
        await f.invoice.save();
        await f.invoice.loadFromId();
        const sentAt = String(f.invoice.sentAt);
        expect(f.invoice.sentAt).not.toBeNull();
        expect(f.invoice.status).toBe(status);
        expect(f.invoice.amountPaid).toBe(amount);
        expect(String(f.invoice.viewedAt)).toBe(viewedAt);
        expect(String(f.invoice.paidDate)).toBe(paidDate);
        f.invoice.markSent();
        await f.invoice.save();
        await f.invoice.loadFromId();
        expect(String(f.invoice.sentAt)).toBe(sentAt);
        await f.reverse();
        expect(f.invoice.status).toBe(
          viewed ? InvoiceStatus.VIEWED : InvoiceStatus.SENT,
        );
        expect(String(f.invoice.sentAt)).toBe(sentAt);
        expect(String(f.invoice.viewedAt)).toBe(viewedAt);
        expect(f.invoice.amountPaid).toBe(0);
        expect(f.invoice.paidDate).toBeNull();
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
        expect(() => f.invoice.markSent()).toThrow(/Cannot send/);
        f.invoice.updatePaymentStatus(0);
        expect(f.invoice.status).toBe(status);
        f.invoice.status = InvoiceStatus.DRAFT;
        await expect(f.invoice.save()).rejects.toThrow(
          /illegal status transition/,
        );
      }));
  });
}
