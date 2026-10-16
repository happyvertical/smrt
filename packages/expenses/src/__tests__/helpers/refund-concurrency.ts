/** Real PostgreSQL interleavings across independent pooled transactions. */
import { randomUUID } from 'node:crypto';
import { GlobalInterceptors } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { expect, it } from 'vitest';
import { ExpenseCollection } from '../../collections/ExpenseCollection.js';
import { Expense } from '../../models/Expense.js';
import { createWorld } from './expense-suite.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Prove that either writer's source lock forces the other to revalidate. */
export function defineRefundConcurrency(getDb: () => DatabaseInterface): void {
  it('rejects an inbound source edit from a stale REPEATABLE READ snapshot', async () => {
    const db = getDb();
    enableTenancy();
    const pinned = deferred<void>();
    const resume = deferred<void>();
    let writer: Promise<unknown> | undefined;
    try {
      const world = await createWorld(db);
      await world.inTenant(async () => {
        const source = await world.expense({ amount: 1000 });
        if (!db.transaction)
          throw new Error('PostgreSQL transactions required');
        writer = db
          .transaction(async (tx) => {
            await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            const expenses = await ExpenseCollection.create({ db: tx });
            const stale = await expenses.get(
              { id: source.id },
              { cache: false },
            );
            if (!stale) throw new Error('Missing source fixture');
            pinned.resolve();
            await resume.promise;
            stale.currency = 'EUR';
            await stale.save();
          })
          .then(
            () => null,
            (error: unknown) => error,
          );
        await pinned.promise;
        await world.expense({ amount: -100, refundOfId: source.id });
        resume.resolve();
        expect(String(await writer)).toMatch(
          /could not serialize|concurrent update/i,
        );
        const fresh = await world.expenses.get(
          { id: source.id },
          { cache: false },
        );
        if (!fresh) throw new Error('Missing source fixture');
        expect(fresh.currency).toBe('USD');
        fresh.currency = 'EUR';
        await expect(fresh.save()).rejects.toMatchObject({
          code: 'EXPENSE_INVALID',
        });
        fresh.currency = 'USD';
        fresh.amount = 1200;
        await fresh.save();
      });
    } finally {
      resume.resolve();
      await writer;
      disableTenancy();
    }
  });

  it.each([
    'refund',
    'source',
  ] as const)('serializes the %s-first inbound refund race', async (firstWriter) => {
    const db = getDb();
    const transactional = db as DatabaseInterface & {
      transaction<T>(work: (tx: DatabaseInterface) => Promise<T>): Promise<T>;
    };
    enableTenancy();
    const name = `expense-refund-race-${randomUUID()}`;
    const held = deferred<void>();
    const release = deferred<void>();
    let first: Promise<unknown> | undefined;
    let second: Promise<{ error?: unknown }> | undefined;
    try {
      const world = await createWorld(db);
      await world.inTenant(async () => {
        const source = await world.expense({ amount: 1000 });
        const createRefund = async (executor: DatabaseInterface) => {
          const expenses = await ExpenseCollection.create({ db: executor });
          return expenses.create({
            amount: -100,
            currency: 'USD',
            incurredOn: '2026-10-01',
            refundOfId: source.id,
          });
        };
        let intercepted = false;
        GlobalInterceptors.register({
          name,
          async beforeSave(instance) {
            if (!(instance instanceof Expense) || intercepted) return;
            const matches =
              firstWriter === 'refund'
                ? instance.refundOfId === source.id
                : instance.id === source.id;
            if (!matches) return;
            intercepted = true;
            held.resolve();
            await release.promise;
          },
        });
        source.currency = 'EUR';
        first = firstWriter === 'refund' ? createRefund(db) : source.save();
        await held.promise;
        const secondStarted = deferred<number>();
        second = transactional
          .transaction(async (tx) => {
            const backend = await tx.query('SELECT pg_backend_pid() AS pid');
            secondStarted.resolve(Number(backend.rows[0].pid));
            if (firstWriter === 'source') {
              await createRefund(tx);
            } else {
              const expenses = await ExpenseCollection.create({ db: tx });
              const loaded = await expenses.get({ id: source.id });
              if (!loaded) throw new Error('Missing source fixture');
              loaded.currency = 'EUR';
              await loaded.save();
            }
            return {};
          })
          .catch((error: unknown) => ({ error }));
        const pid = await secondStarted.promise;
        try {
          // Inspect a real lock wait, not a timer-based assumption about ordering.
          await expect
            .poll(
              async () => {
                const result = await db.query(
                  'SELECT cardinality(pg_blocking_pids(?)) AS blockers',
                  pid,
                );
                return Number(result.rows[0].blockers);
              },
              { timeout: 5000, interval: 25 },
            )
            .toBeGreaterThan(0);
        } finally {
          release.resolve();
        }
        await first;
        expect((await second).error).toMatchObject({ code: 'EXPENSE_INVALID' });
        const stored = await world.expenses.get({ id: source.id });
        const refunds = await world.expenses.list({
          where: { refundOfId: source.id },
        });
        expect(stored?.currency).toBe(firstWriter === 'refund' ? 'USD' : 'EUR');
        expect(refunds).toHaveLength(firstWriter === 'refund' ? 1 : 0);
        if (refunds.length) expect(refunds[0].currency).toBe(stored?.currency);
      });
    } finally {
      release.resolve();
      await Promise.allSettled([first, second]);
      GlobalInterceptors.unregister(name);
      disableTenancy();
    }
  });
  it.each([
    'amount',
    'financial-facts',
  ] as const)('rejects a stale sibling refund %s edit under REPEATABLE READ', async (change) => {
    const db = getDb();
    enableTenancy();
    const pinned = deferred<void>();
    const resume = deferred<void>();
    let writer: Promise<unknown> | undefined;
    try {
      const world = await createWorld(db);
      await world.inTenant(async () => {
        const financial = change === 'financial-facts';
        const source = await world.expense({
          amount: 1000,
          ...(financial
            ? {
                financialBreakdown: JSON.stringify({
                  currency: 'USD',
                  subtotal: 900,
                  taxes: [
                    {
                      code: 'supplier-tax',
                      amount: 100,
                      recoverableAmount: 40,
                    },
                  ],
                  total: 1000,
                }),
              }
            : {}),
        });
        const first = await world.expense({
          amount: financial ? -100 : -400,
          refundOfId: source.id,
        });
        const second = await world.expense({
          amount: financial ? -100 : -400,
          refundOfId: source.id,
        });
        if (!db.transaction) throw new Error('Transactions required');
        writer = db
          .transaction(async (tx) => {
            await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            const expenses = await ExpenseCollection.create({ db: tx });
            const stale = await expenses.get(
              { id: second.id },
              { cache: false },
            );
            if (!stale) throw new Error('Missing refund');
            pinned.resolve();
            await resume.promise;
            if (financial)
              stale.setFinancialBreakdown({
                currency: 'USD',
                subtotal: -99,
                taxes: [
                  { code: 'supplier-tax', amount: -1, recoverableAmount: 0 },
                ],
                total: -100,
              });
            else stale.amount = -500;
            await stale.save();
          })
          .then(
            () => null,
            (error: unknown) => error,
          );
        await pinned.promise;
        if (financial)
          first.setFinancialBreakdown({
            currency: 'USD',
            subtotal: 0,
            taxes: [
              { code: 'supplier-tax', amount: -100, recoverableAmount: -40 },
            ],
            total: -100,
          });
        else first.amount = -600;
        await first.save();
        resume.resolve();
        expect(String(await writer)).toMatch(
          /could not serialize|concurrent update/i,
        );
        const fresh = await world.expenses.get(
          { id: second.id },
          { cache: false },
        );
        if (!fresh) throw new Error('Missing refund');
        if (financial)
          fresh.setFinancialBreakdown({
            currency: 'USD',
            subtotal: -99,
            taxes: [{ code: 'supplier-tax', amount: -1, recoverableAmount: 0 }],
            total: -100,
          });
        else fresh.amount = -500;
        await expect(fresh.save()).rejects.toMatchObject({
          code: 'EXPENSE_INVALID',
        });
        expect(
          (await world.expenses.refundPosition(source.id)).refundedAmount,
        ).toBe(financial ? 200 : 1000);
      });
    } finally {
      resume.resolve();
      await writer;
      disableTenancy();
    }
  });
}
