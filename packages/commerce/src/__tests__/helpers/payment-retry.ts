/** Atomic payment posting regressions (#3108), also run in the PostgreSQL lane. */
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  AccountCollection,
  JournalCollection,
} from '@happyvertical/smrt-ledgers';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
} from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentCollection } from '../../collections/PaymentCollection.js';
import { Payment } from '../../models/Payment.js';
import { PaymentStatus } from '../../types/index.js';

export function paymentRetryContract(postgres = false, enabled = true): void {
  const suite = enabled ? describe : describe.skip;
  suite(`payment posting retries (${postgres ? 'postgres' : 'sqlite'})`, () => {
    let isolated: Pick<IsolatedTestDbResult, 'baseDb' | 'cleanup'>;
    let payments: PaymentCollection;
    let journals: JournalCollection;
    let posting: {
      ledgerId: string;
      cashAccountId: string;
      receivablesAccountId: string;
    };
    beforeEach(async () => {
      const classes = [
        'Payment',
        'Customer',
        'Contract',
        '@happyvertical/smrt-ledgers:Account',
        'Journal',
        'JournalEntry',
      ];
      if (!postgres) {
        const db = await getTestDatabase({
          type: 'sqlite',
          url: ':memory:',
          classes,
        });
        isolated = {
          baseDb: db as IsolatedTestDbResult['baseDb'],
          cleanup: async () => {
            await db.close?.();
          },
        };
      } else {
        isolated = await createIsolatedTestDbFromManifest({
          includeObjects: classes,
        });
      }
      const db = isolated.baseDb;
      payments = await PaymentCollection.create({ db });
      journals = await JournalCollection.create({ db });
      const accounts = await AccountCollection.create({ db });
      const cash = await accounts.create({
        number: '1000',
        name: 'Cash',
        type: 'asset',
      });
      await cash.save();
      const ar = await accounts.create({
        number: '1200',
        name: 'AR',
        type: 'asset',
      });
      await ar.save();
      posting = {
        ledgerId: '',
        cashAccountId: cash.id!,
        receivablesAccountId: ar.id!,
      };
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      disableTenancy();
      await isolated?.cleanup();
    });

    async function pending() {
      const payment = await payments.create({ amount: 1234, currency: 'USD' });
      await payment.save();
      return payment;
    }

    it('rolls back a posted journal when completion fails and retries the same instance', async () => {
      const payment = await pending();
      const save = payment.save.bind(payment);
      const fault = vi
        .spyOn(payment, 'save')
        .mockImplementationOnce(async () => {
          throw new Error('completion interrupted');
        });
      await expect(payment.recordPayment(posting)).rejects.toThrow(
        'completion interrupted',
      );
      expect(await journals.count({ where: { sourceRef: payment.id } })).toBe(
        0,
      );
      expect(payment.status).toBe(PaymentStatus.PENDING);
      expect((await payments.get({ id: payment.id }))?.status).toBe(
        PaymentStatus.PENDING,
      );
      fault.mockImplementation(save);
      await payment.recordPayment(posting);
      expect(await journals.count({ where: { sourceRef: payment.id } })).toBe(
        1,
      );
    });

    it('rejects a stale second instance without creating another journal', async () => {
      const payment = await pending();
      const stale = (await payments.get({ id: payment.id }))!;
      await payment.recordPayment(posting);
      await expect(stale.recordPayment(posting)).rejects.toThrow();
      expect(await journals.count({ where: { sourceRef: payment.id } })).toBe(
        1,
      );
    });

    it('allows only one competing settlement', async () => {
      const payment = await pending();
      const second = (await payments.get({ id: payment.id }))!;
      const results = await Promise.allSettled([
        payment.recordPayment(posting),
        second.recordPayment(posting),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(await journals.count({ where: { sourceRef: payment.id } })).toBe(
        1,
      );
    });

    it('keeps settlement inside the caller transaction', async () => {
      const payment = await pending();
      await expect(
        payment.withTransaction(async () => {
          await payment.recordPayment(posting);
          throw new Error('outer interrupted');
        }),
      ).rejects.toThrow('outer interrupted');
      expect(await journals.count({ where: { sourceRef: payment.id } })).toBe(
        0,
      );
      const reloaded = (await payments.get({ id: payment.id }))!;
      expect(reloaded.status).toBe(PaymentStatus.PENDING);
      await reloaded.recordPayment(posting);
      expect(await journals.count({ where: { sourceRef: payment.id } })).toBe(
        1,
      );
    });

    it('serializes calls on the same instance without rebinding it twice', async () => {
      const payment = await pending();
      const results = await Promise.allSettled([
        payment.recordPayment(posting),
        payment.recordPayment(posting),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(await journals.count({ where: { sourceRef: payment.id } })).toBe(
        1,
      );
      expect(await (await payment.getJournal())?.isBalanced()).toBe(true);
    });

    it('rolls back an unsaved payment and can retry it after a completion failure', async () => {
      const payment = new Payment({ db: payments.db, amount: 1234 });
      await payment.initialize();
      expect(payment.isPersisted).toBe(false);
      const save = payment.save.bind(payment);
      const fault = vi.spyOn(payment, 'save').mockImplementation(async () => {
        if (payment.status === PaymentStatus.COMPLETED)
          throw new Error('completion interrupted');
        return save();
      });
      await expect(payment.recordPayment(posting)).rejects.toThrow(
        'completion interrupted',
      );
      expect(payment.isPersisted).toBe(false);
      expect(payment.status).toBe(PaymentStatus.PENDING);
      fault.mockImplementation(save);
      const journal = await payment.recordPayment(posting);
      expect(await journal.isBalanced()).toBe(true);
      expect(await journals.count({ where: { sourceRef: payment.id } })).toBe(
        1,
      );
    });

    it.skipIf(!postgres)(
      'fences a competing repeatable-read snapshot',
      async () => {
        const payment = await pending();
        let releaseSnapshot!: () => void;
        let snapshotReady!: () => void;
        const ready = new Promise<void>((resolve) => {
          snapshotReady = resolve;
        });
        const released = new Promise<void>((resolve) => {
          releaseSnapshot = resolve;
        });
        const stale = isolated.baseDb.transaction(async (tx) => {
          await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
          const collection = await PaymentCollection.create({ db: tx });
          const snapshot = (await collection.get({ id: payment.id }))!;
          snapshotReady();
          await released;
          await snapshot.recordPayment(posting);
        });
        const rejection = expect(stale).rejects.toThrow();
        await ready;
        try {
          await payment.recordPayment(posting);
        } finally {
          releaseSnapshot();
        }
        await rejection;
        expect(await journals.count({ where: { sourceRef: payment.id } })).toBe(
          1,
        );
      },
    );

    it('rejects missing revision metadata without posting', async () => {
      const payment = await pending();
      payment.updated_at = null;
      await expect(payment.recordPayment(posting)).rejects.toThrow(
        'Payment revision is missing',
      );
      expect(await journals.count({ where: { sourceRef: payment.id } })).toBe(
        0,
      );
    });

    it('denies a foreign tenant before creating a journal', async () => {
      enableTenancy();
      const payment = await withTenant(
        { tenantId: '11111111-1111-4111-8111-111111111111' },
        pending,
      );
      await expect(
        withTenant({ tenantId: '22222222-2222-4222-8222-222222222222' }, () =>
          payment.recordPayment(posting),
        ),
      ).rejects.toThrow();
      expect(await journals.count({ where: { sourceRef: payment.id } })).toBe(
        0,
      );
    });
  });
}
