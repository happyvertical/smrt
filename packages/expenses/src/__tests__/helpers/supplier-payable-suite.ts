import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ExpenseCollection } from '../../collections/ExpenseCollection.js';
import type {
  RecordSupplierPayableEventInput,
  RecordSupplierPayableInput,
  SupplierPayableEventInput,
} from '../../supplier-payable.js';
import { createWorld, type ExpenseWorld } from './expense-suite.js';

const source = (key: string) => ({
  namespace: 'synthetic-original',
  key,
  version: '1',
  author: 'original supplier bookkeeper, not a current user',
});
function original(basis: number | null = 1000): RecordSupplierPayableInput {
  return {
    requestId: randomUUID(),
    currency: 'USD',
    source: source('original'),
    payableBasisMinor: basis,
    recordedByProfileId: randomUUID(),
    evidenceRef: 'current import review, not original approval',
    events: [
      {
        kind: 'hold',
        amountMinor: 100,
        effectiveOn: '2026-09-15',
        sequence: 0,
        evidenceRef: 'original held amount',
        source: source('held'),
      },
    ],
  };
}
function event(
  value: SupplierPayableEventInput,
): RecordSupplierPayableEventInput {
  return {
    requestId: randomUUID(),
    currency: 'USD',
    recordedByProfileId: randomUUID(),
    evidenceRef: 'current explicit supplier evidence review',
    event: value,
  };
}
const move = (
  kind: 'hold' | 'release' | 'settlement',
  amountMinor: number,
  date = '2026-09-16',
  sequence = 0,
) =>
  event({
    kind,
    amountMinor,
    effectiveOn: date,
    sequence,
    evidenceRef: 'explicit dated evidence',
  });
export function defineSupplierPayableSuite(getDb: () => DatabaseInterface) {
  let world: ExpenseWorld;
  beforeEach(async () => {
    enableTenancy();
    world = await createWorld(getDb());
  });
  afterEach(() => disableTenancy());
  it('preserves exact original held/release identities with unknown basis, then completes once without repricing incurred facts', async () =>
    world.inTenant(async () => {
      const expense = await world.expense({ amount: 1000 });
      const input = original(null);
      input.source.author = null;
      input.events.push({
        ...move('release', 20).event,
        source: source('released'),
      });
      const first = await expense.recordSupplierPayable(input),
        retry = await expense.recordSupplierPayable(input);
      expect(retry).toEqual(first);
      expect(
        await expense.getSupplierPayablePosition({ asOfDate: '2026-09-14' }),
      ).toBeNull();
      expect(first).toMatchObject({
        heldMinor: 100,
        releasedMinor: 20,
        retainedMinor: 80,
        remainingPayableMinor: null,
        unknownReasons: ['payable-basis-unknown'],
      });
      expect(first.authority.events[0].id).toMatch(/^[\da-f-]{36}$/);
      expect(first.authority.events[0].source?.author).toContain(
        'not a current user',
      );
      expect(
        (await expense.getSupplierPayablePosition({ asOfDate: '2026-09-15' }))
          ?.retainedMinor,
      ).toBe(100);
      await expect(
        expense.recordSupplierPayable({ ...input, payableBasisMinor: 1000 }),
      ).rejects.toMatchObject({ code: 'EXPENSE_INVALID' });
      await expect(
        expense.recordSupplierPayableEvent(move('settlement', 1)),
      ).rejects.toMatchObject({ code: 'EXPENSE_INVALID' });
      const completion = {
        requestId: randomUUID(),
        currency: 'USD',
        payableBasisMinor: 1000,
        recordedByProfileId: randomUUID(),
        evidenceRef: 'separately reviewed original supplier obligation',
      };
      const completed = await expense.completeSupplierPayableBasis(completion);
      expect(completed.remainingPayableMinor).toBe(920);
      expect(completed.authority.original.payableBasisMinor).toBeNull();
      expect(await expense.completeSupplierPayableBasis(completion)).toEqual(
        completed,
      );
      await expect(
        expense.completeSupplierPayableBasis({
          ...completion,
          payableBasisMinor: 900,
        }),
      ).rejects.toMatchObject({ code: 'EXPENSE_INVALID' });
      const fresh = await world.expenses.get(expense.id, { cache: false });
      expect(fresh?.amount).toBe(1000);
      expect(fresh?.getCostBasis()).toBeNull();
      expect(fresh?.reviewStatus).toBe('unreviewed');
      expect(fresh?.reimbursedAt).toBeNull();
    }));
  it('conserves supplier releases, settlements and explicit refund directions in historical order', async () =>
    world.inTenant(async () => {
      const expense = await world.expense({ amount: 1000 });
      await expense.recordSupplierPayable(original());
      await expense.recordSupplierPayableEvent(move('settlement', 900));
      await expect(
        expense.recordSupplierPayableEvent(move('settlement', 1, '2026-09-17')),
      ).rejects.toMatchObject({ code: 'EXPENSE_INVALID' });
      await expense.recordSupplierPayableEvent(
        move('release', 50, '2026-09-17'),
      );
      const payment = move('settlement', 50, '2026-09-17', 1);
      const paid = await expense.recordSupplierPayableEvent(payment);
      expect(await expense.recordSupplierPayableEvent(payment)).toEqual(paid);
      const refund = await world.expense({
        amount: -100,
        refundOfId: expense.id,
        incurredOn: '2026-09-18',
      });
      expect(
        (await expense.getSupplierPayablePosition())?.unknownReasons,
      ).toEqual(['refund-interpretation-required']);
      await expect(
        expense.recordSupplierPayableEvent(move('settlement', 1, '2026-09-19')),
      ).rejects.toMatchObject({ code: 'EXPENSE_INVALID' });
      expect(await expense.getSupplierPayablePosition()).toMatchObject({
        recordedRetainedMinor: 50,
        retainedMinor: null,
        netPaidMinor: null,
      });
      await expect(
        expense.recordSupplierPayableEvent(move('release', 1, '2026-09-19')),
      ).rejects.toMatchObject({ code: 'EXPENSE_INVALID' });
      const disposition = event({
        kind: 'refund',
        refundExpenseId: refund.id,
        payableReductionMinor: 100,
        retainedReductionMinor: 0,
        cashReturnedMinor: 100,
        effectiveOn: '2026-09-18',
        sequence: 0,
        evidenceRef: 'supplier returned cash against original paid amount',
      });
      const reconciled = await expense.recordSupplierPayableEvent(disposition);
      expect(reconciled).toMatchObject({
        remainingPayableMinor: 0,
        retainedMinor: 50,
        settledMinor: 950,
        cashReturnedMinor: 100,
        netPaidMinor: 850,
        payableReductionMinor: 100,
      });
      expect(
        (await expense.getSupplierPayablePosition({ asOfDate: '2026-09-17' }))
          ?.netPaidMinor,
      ).toBe(950);
      await expect(
        expense.recordSupplierPayableEvent({
          ...disposition,
          requestId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'EXPENSE_INVALID' });
      refund.amount = -99;
      await expect(refund.save()).rejects.toMatchObject({
        code: 'EXPENSE_INVALID',
      });
      await expect(refund.delete()).rejects.toMatchObject({
        code: 'EXPENSE_INVALID',
      });
      const credit = await world.expense({
        amount: -20,
        refundOfId: expense.id,
        incurredOn: '2026-09-19',
      });
      const final = await expense.recordSupplierPayableEvent(
        event({
          kind: 'refund',
          refundExpenseId: credit.id,
          payableReductionMinor: 20,
          retainedReductionMinor: 20,
          cashReturnedMinor: 0,
          effectiveOn: '2026-09-19',
          sequence: 0,
          evidenceRef: 'explicit retained debt reduction, no cash received',
        }),
      );
      expect(final).toMatchObject({
        remainingPayableMinor: 0,
        retainedMinor: 30,
        netPaidMinor: 850,
      });
    }));
  it('rejects interim negative capacity, ambiguous ordering, malformed kind/currency and cash return without earlier payment', async () =>
    world.inTenant(async () => {
      const expense = await world.expense({ amount: 1000 });
      const bad = original();
      bad.events.unshift({
        ...move('release', 10, '2026-09-15', 0).event,
        source: source('bad'),
      });
      await expect(expense.recordSupplierPayable(bad)).rejects.toMatchObject({
        code: 'EXPENSE_INVALID',
      });
      expect(await expense.getSupplierPayablePosition()).toBeNull();
      await expense.recordSupplierPayable(original());
      await expect(
        expense.recordSupplierPayableEvent(move('release', 101)),
      ).rejects.toMatchObject({ code: 'EXPENSE_INVALID' });
      await expect(
        expense.recordSupplierPayableEvent({
          ...move('release', 10),
          currency: 'CAD',
        }),
      ).rejects.toMatchObject({ code: 'EXPENSE_INVALID' });
      await expect(
        expense.recordSupplierPayableEvent(
          event({
            kind: 'invented',
            amountMinor: 1,
            effectiveOn: '2026-09-16',
            sequence: 0,
            evidenceRef: 'invalid',
          } as never),
        ),
      ).rejects.toMatchObject({ code: 'EXPENSE_INVALID' });
      const refund = await world.expense({
        amount: -10,
        refundOfId: expense.id,
        incurredOn: '2026-09-16',
      });
      await expect(
        expense.recordSupplierPayableEvent(
          event({
            kind: 'refund',
            refundExpenseId: refund.id,
            payableReductionMinor: 10,
            retainedReductionMinor: 0,
            cashReturnedMinor: 10,
            effectiveOn: '2026-09-16',
            sequence: 0,
            evidenceRef: 'no earlier paid capacity',
          }),
        ),
      ).rejects.toMatchObject({ code: 'EXPENSE_INVALID' });
    }));
  it('guards direct save/delete, preserves caller rollback and isolates tenant ownership', async () =>
    world.inTenant(async () => {
      const expense = await world.expense({ amount: 1000 }),
        input = original();
      await expect(
        getDb().transaction!(async (tx) => {
          const collection = await ExpenseCollection.create({ db: tx });
          await collection.recordSupplierPayable(expense.id, input);
          throw new Error('outer rollback');
        }),
      ).rejects.toThrow('outer rollback');
      expect(await expense.getSupplierPayablePosition()).toBeNull();
      const result = await expense.recordSupplierPayable(input);
      let fresh = (await world.expenses.get(expense.id, { cache: false }))!;
      fresh.supplierPayableJson = null;
      await expect(fresh.save()).rejects.toMatchObject({
        code: 'EXPENSE_INVALID',
      });
      fresh = (await world.expenses.get(expense.id, { cache: false }))!;
      fresh.amount = 999;
      await expect(fresh.save()).rejects.toMatchObject({
        code: 'EXPENSE_INVALID',
      });
      await expect(expense.delete()).rejects.toMatchObject({
        code: 'EXPENSE_INVALID',
      });
      const foreign = await createWorld(getDb());
      await foreign.inTenant(async () => {
        await expect(
          expense.getSupplierPayablePosition(),
        ).rejects.toMatchObject({ code: 'EXPENSE_INVALID' });
        await expect(expense.delete()).rejects.toMatchObject({
          code: 'EXPENSE_INVALID',
        });
        await expect(
          foreign.expenses.supplierPayablePosition(expense.id),
        ).rejects.toBeDefined();
      });
      await expect(
        world.expenses.create({
          amount: 1000,
          currency: 'USD',
          incurredOn: '2026-09-15',
          recordedByProfileId: randomUUID(),
          supplierPayableJson: JSON.stringify(result.authority),
        }),
      ).rejects.toMatchObject({
        code: 'EXPENSE_INVALID',
      });
      await expect(
        getDb().transaction!(async (tx) => {
          await (
            await ExpenseCollection.create({ db: tx })
          ).recordSupplierPayableEvent(expense.id, move('release', 50));
          throw new Error('event rollback');
        }),
      ).rejects.toThrow('event rollback');
      expect((await expense.getSupplierPayablePosition())?.retainedMinor).toBe(
        100,
      );
    }));
  it('serializes competing releases and exact event retry without duplicating child identities', async () =>
    world.inTenant(async () => {
      const expense = await world.expense({ amount: 1000 });
      await expense.recordSupplierPayable(original());
      const replay = move('settlement', 500);
      const both = await Promise.all([
        world.expenses.recordSupplierPayableEvent(expense.id, replay),
        world.expenses.recordSupplierPayableEvent(expense.id, replay),
      ]);
      expect(both[0].authority.events).toEqual(both[1].authority.events);
      const outcomes = await Promise.allSettled([
        world.expenses.recordSupplierPayableEvent(
          expense.id,
          move('release', 60, '2026-09-17', 0),
        ),
        world.expenses.recordSupplierPayableEvent(
          expense.id,
          move('release', 60, '2026-09-17', 1),
        ),
      ]);
      expect(
        outcomes.filter((value) => value.status === 'fulfilled'),
      ).toHaveLength(1);
      expect((await expense.getSupplierPayablePosition())?.retainedMinor).toBe(
        40,
      );
    }));
}
