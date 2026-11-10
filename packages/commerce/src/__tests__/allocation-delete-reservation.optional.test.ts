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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaymentCollection } from '../collections/PaymentCollection.js';
import { Payment } from '../models/Payment.js';
import { syncRetainedRefundToAccounting } from '../retention-accounting.js';
import { allocationDeleteReservationFixture } from './helpers/allocation-delete-reservation-fixture.js';

const classes = [
  'Customer',
  'Invoice',
  'InvoiceLineItem',
  'DocumentTax',
  'TaxCode',
  'TaxComponent',
  'TaxSettings',
  'Payment',
  'PaymentAllocation',
  'Account',
  'Journal',
  'JournalEntry',
];
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
afterEach(() => {
  vi.restoreAllMocks();
  disableTenancy();
});
for (const engine of [
  'sqlite',
  ...(isPostgresAvailable() ? ['postgres'] : []),
]) {
  describe(`allocation deletion and provider reservation (${engine})`, () => {
    async function database() {
      if (engine === 'postgres') {
        const isolated = await createIsolatedTestDbFromManifest({
          includeObjects: classes,
        });
        return { db: isolated.baseDb, cleanup: isolated.cleanup };
      }
      const db = await getTestDatabase({
        type: 'sqlite',
        url: ':memory:',
        classes,
      });
      return {
        db,
        cleanup: async () => {
          await db.close?.();
        },
      };
    }
    async function testFixture(
      run: (db: DatabaseInterface, tenantId: string) => Promise<void>,
    ) {
      const { db, cleanup } = await database();
      enableTenancy();
      const tenantId = randomUUID();
      try {
        await withTenant({ tenantId }, () => run(db, tenantId));
      } finally {
        await cleanup();
      }
    }
    it('deletes ordinary evidence atomically but retains provider-bound refund evidence and revision', async () =>
      testFixture(async (db, tenantId) => {
        const fixture = await allocationDeleteReservationFixture(db, tenantId);
        const before = await fixture.payments.get(
          { id: fixture.refund.id! },
          { cache: false },
        );
        await expect(
          db.transaction!(async (tx) => {
            const row = await (
              await (
                await import('../collections/PaymentAllocationCollection.js')
              ).PaymentAllocationCollection.create({ db: tx })
            ).get({ id: fixture.allocation.id! }, { cache: false });
            if (!row) throw new Error('Missing allocation');
            await row.delete();
            throw new Error('owned-delete-rollback');
          }),
        ).rejects.toThrow('owned-delete-rollback');
        expect(
          await fixture.allocations.get(
            { id: fixture.allocation.id! },
            { cache: false },
          ),
        ).not.toBeNull();
        expect(
          (
            await fixture.payments.get(
              { id: fixture.refund.id! },
              { cache: false },
            )
          )?.updated_at,
        ).toEqual(before?.updated_at);
        await fixture.allocation.delete();
        expect(
          (
            await fixture.payments.get(
              { id: fixture.refund.id! },
              { cache: false },
            )
          )?.updated_at,
        ).not.toEqual(before?.updated_at);
        expect(
          await fixture.allocations.get(
            { id: fixture.allocation.id! },
            { cache: false },
          ),
        ).toBeNull();
        const restored = await fixture.allocations.create({
          id: randomUUID(),
          paymentId: fixture.refund.id!,
          invoiceId: fixture.command.creditInvoiceId,
          amount: 100,
        });
        await syncRetainedRefundToAccounting(fixture.command);
        const bound = await fixture.payments.get(
          { id: fixture.refund.id! },
          { cache: false },
        );
        await expect(restored.delete()).rejects.toThrow('cannot be deleted');
        expect(
          (
            await fixture.payments.get(
              { id: fixture.refund.id! },
              { cache: false },
            )
          )?.updated_at,
        ).toEqual(bound?.updated_at);
        await expect(
          withTenant({ tenantId: randomUUID() }, () => restored.delete()),
        ).rejects.toThrow();
        expect(
          await fixture.allocations.get({ id: restored.id! }, { cache: false }),
        ).not.toBeNull();
      }));
    if (engine === 'postgres')
      it('refuses provider reservation without external I/O when claimed deletion commits first', async () =>
        testFixture(async (db, tenantId) => {
          const fixture = await allocationDeleteReservationFixture(
              db,
              tenantId,
            ),
            claimed = gate(),
            resume = gate(),
            providerClaim = gate();
          const claim = Payment.prototype.claimRevision;
          let intercepted = false;
          const spy = vi
            .spyOn(Payment.prototype, 'claimRevision')
            .mockImplementation(async function (this: Payment, expected) {
              if (this.id === fixture.refund.id) {
                if (!intercepted) {
                  intercepted = true;
                  const result = await claim.call(this, expected);
                  claimed.release();
                  await resume.promise;
                  return result;
                }
                providerClaim.release();
              }
              return claim.call(this, expected);
            });
          const calls = fixture.execute.mock.calls.length;
          const deletion = fixture.allocation.delete().then(
            () => null,
            (error) => error,
          );
          let reservation: Promise<unknown> | undefined;
          try {
            await claimed.promise;
            reservation = syncRetainedRefundToAccounting(fixture.command).then(
              () => null,
              (error) => error,
            );
            await providerClaim.promise;
          } finally {
            resume.release();
          }
          try {
            expect(await deletion).toBeNull();
            expect(await reservation).toBeInstanceOf(Error);
            expect(
              await fixture.allocations.get(
                { id: fixture.allocation.id! },
                { cache: false },
              ),
            ).toBeNull();
            expect(
              (
                await fixture.payments.get(
                  { id: fixture.refund.id! },
                  { cache: false },
                )
              )?.retentionAccountingBindingJson,
            ).toBe('');
            expect(fixture.execute).toHaveBeenCalledTimes(calls);
            const invoice = await fixture.invoices.get(
              { id: fixture.command.invoiceId },
              { cache: false },
            );
            expect(
              JSON.parse(invoice!.retentionAccountingStateJson).refunds,
            ).toEqual([]);
          } finally {
            spy.mockRestore();
          }
        }));
    if (engine === 'postgres')
      it('rejects stale deletion after provider reservation commits against its unbound parent read', async () =>
        testFixture(async (db, tenantId) => {
          const fixture = await allocationDeleteReservationFixture(
              db,
              tenantId,
            ),
            read = gate(),
            resume = gate();
          const get = PaymentCollection.prototype.get;
          let intercepted = false;
          const spy = vi
            .spyOn(PaymentCollection.prototype, 'get')
            .mockImplementation(async function (
              this: PaymentCollection,
              ...args
            ) {
              const payment = await get.apply(this, args);
              if (!intercepted && payment && payment.id === fixture.refund.id) {
                intercepted = true;
                expect(payment.retentionAccountingBindingJson).toBe('');
                read.release();
                await resume.promise;
              }
              return payment;
            });
          const deletion = fixture.allocation.delete().then(
            () => null,
            (error) => error,
          );
          try {
            await read.promise;
            const recorded = await syncRetainedRefundToAccounting(
              fixture.command,
            );
            expect(recorded.refunds[0]).toMatchObject({
              paymentId: fixture.refund.id,
              committed: true,
            });
          } finally {
            resume.release();
            spy.mockRestore();
          }
          expect(await deletion).toBeInstanceOf(Error);
          expect(
            await fixture.allocations.get(
              { id: fixture.allocation.id! },
              { cache: false },
            ),
          ).not.toBeNull();
          const calls = fixture.execute.mock.calls.length;
          await syncRetainedRefundToAccounting(fixture.command);
          expect(fixture.execute).toHaveBeenCalledTimes(calls);
        }));
  });
}
