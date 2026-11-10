/** Shared adapter contract: exact cash capacity and source-component reversals. */
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { ExpenseCollection } from '../../collections/ExpenseCollection.js';
import type { ExpenseFinancialBreakdown } from '../../types.js';
import type { ExpenseWorld } from './expense-suite.js';

const breakdown = (
  subtotal: number,
  tax: number,
  recovery: number,
): ExpenseFinancialBreakdown => ({
  currency: 'USD',
  subtotal,
  taxes: [{ code: 'supplier-tax', amount: tax, recoverableAmount: recovery }],
  total: subtotal + tax,
});

export function defineRefundPositionSuite(getWorld: () => ExpenseWorld): void {
  it('bounds all persisted cash refunds and source edits, with explicit unknown financial facts', async () => {
    const world = getWorld();
    await world.inTenant(async () => {
      const source = await world.expense({ amount: 1000 });
      const first = await world.expense({
        amount: -600,
        refundOfId: source.id,
      });
      await first.reject({
        reason: 'Still received cash reversal',
        reviewerProfileId: randomUUID(),
      });
      await expect(
        world.expense({ amount: -401, refundOfId: source.id }),
      ).rejects.toMatchObject({ code: 'EXPENSE_INVALID' });
      const second = await world.expense({
        amount: -400,
        refundOfId: source.id,
      });
      expect(await world.expenses.refundPosition(source.id)).toMatchObject({
        sourceAmount: 1000,
        refundedAmount: 1000,
        remainingAmount: 0,
        financialPosition: null,
        refundIds: [first.id, second.id].sort(),
      });
      const fresh = await world.expenses.get(
        { id: source.id },
        { cache: false },
      );
      if (!fresh) throw new Error('Missing source');
      fresh.amount = 999;
      await expect(fresh.save()).rejects.toMatchObject({
        code: 'EXPENSE_INVALID',
      });
      second.amount = -401;
      await expect(second.save()).rejects.toMatchObject({
        code: 'EXPENSE_INVALID',
      });
      expect(
        (await world.expenses.refundPosition(source.id)).remainingAmount,
      ).toBe(0);
    });
  });

  it('includes every refund page in capacity, source edits and reimbursement', async () => {
    const world = getWorld();
    await world.inTenant(async () => {
      const profileId = randomUUID();
      const source = await world.expense({
        amount: 201,
        paidBy: 'person',
        paidByProfileId: profileId,
        reimbursable: true,
      });
      for (let index = 0; index < 201; index++) {
        await world.expense({
          amount: -1,
          refundOfId: source.id,
          refundRecipient: JSON.stringify({ kind: 'person', profileId }),
        });
      }
      const position = await source.getRefundPosition();
      expect(position).toMatchObject({
        refundedAmount: 201,
        remainingAmount: 0,
      });
      expect(position.refundIds).toHaveLength(201);
      expect(await source.getReimbursementPosition()).toMatchObject({
        remainingAmount: 0,
        personRefundAmount: 201,
      });
      await expect(
        world.expense({ amount: -1, refundOfId: source.id }),
      ).rejects.toMatchObject({ code: 'EXPENSE_INVALID' });
      const fresh = await world.expenses.get(
        { id: source.id },
        { cache: false },
      );
      if (!fresh) throw new Error('Missing source');
      fresh.amount = 200;
      await expect(fresh.save()).rejects.toMatchObject({
        code: 'EXPENSE_INVALID',
      });
      expect((await source.getRefundPosition()).remainingAmount).toBe(0);
    });
  }, 60000);

  it('returns exact signed component residuals without changing source gross', async () => {
    const world = getWorld();
    await world.inTenant(async () => {
      const source = await world.expense({
        amount: 11000,
        financialBreakdown: JSON.stringify(breakdown(10000, 1000, 400)),
      });
      const refund = await world.expense({
        amount: -3300,
        refundOfId: source.id,
        financialBreakdown: JSON.stringify(breakdown(-3000, -300, -100)),
      });
      expect(await world.expenses.refundPosition(source.id)).toMatchObject({
        sourceAmount: 11000,
        refundedAmount: 3300,
        remainingAmount: 7700,
        financialPosition: {
          source: breakdown(10000, 1000, 400),
          refunded: breakdown(-3000, -300, -100),
          remaining: breakdown(7000, 700, 300),
        },
      });
      refund.setFinancialBreakdown(null);
      await expect(refund.save()).rejects.toMatchObject({
        code: 'EXPENSE_INVALID',
      });
      const fresh = await world.expenses.get(
        { id: source.id },
        { cache: false },
      );
      if (!fresh) throw new Error('Missing source');
      fresh.setFinancialBreakdown(null);
      await expect(fresh.save()).rejects.toMatchObject({
        code: 'EXPENSE_INVALID',
      });
      expect((await world.expenses.get({ id: source.id }))?.amount).toBe(11000);
    });
  });

  it.each([
    ['subtotal', breakdown(-10001, 0, 0)],
    ['charged tax', breakdown(0, -1001, -400)],
    ['recovery', breakdown(0, -401, -401)],
    ['nonrecoverable', breakdown(0, -601, 0)],
    [
      'component identity',
      {
        ...breakdown(0, -1, 0),
        taxes: [{ code: 'different-tax', amount: -1, recoverableAmount: 0 }],
      },
    ],
  ])('rejects %s cross-component compensation', async (_name, facts) => {
    const world = getWorld();
    await world.inTenant(async () => {
      const source = await world.expense({
        amount: 11000,
        financialBreakdown: JSON.stringify(breakdown(10000, 1000, 400)),
      });
      await expect(
        world.expense({
          amount: facts.total,
          refundOfId: source.id,
          financialBreakdown: JSON.stringify(facts),
        }),
      ).rejects.toMatchObject({ code: 'EXPENSE_INVALID' });
      expect(
        (await world.expenses.refundPosition(source.id)).refundedAmount,
      ).toBe(0);
    });
  });

  it('keeps incomplete facts unknown while bounding every known component cumulatively', async () => {
    const world = getWorld();
    await world.inTenant(async () => {
      const source = await world.expense({
        amount: 11000,
        financialBreakdown: JSON.stringify(breakdown(10000, 1000, 400)),
      });
      await world.expense({ amount: -10, refundOfId: source.id });
      await world.expense({
        amount: -300,
        refundOfId: source.id,
        financialBreakdown: JSON.stringify(breakdown(0, -300, -300)),
      });
      await expect(
        world.expense({
          amount: -101,
          refundOfId: source.id,
          financialBreakdown: JSON.stringify(breakdown(0, -101, -101)),
        }),
      ).rejects.toMatchObject({ code: 'EXPENSE_INVALID' });
      expect(await world.expenses.refundPosition(source.id)).toMatchObject({
        remainingAmount: 10690,
        financialPosition: null,
      });
      const unknownSource = await world.expense({ amount: 100 });
      await world.expense({
        amount: -50,
        refundOfId: unknownSource.id,
        financialBreakdown: JSON.stringify({
          currency: 'USD',
          subtotal: -50,
          taxes: [],
          total: -50,
        }),
      });
      expect(
        (await world.expenses.refundPosition(unknownSource.id))
          .financialPosition,
      ).toBeNull();
    });
  });
  it('revalidates prospective source components and refund reparenting', async () => {
    const world = getWorld();
    await world.inTenant(async () => {
      const source = await world.expense({
        amount: 11000,
        financialBreakdown: JSON.stringify(breakdown(10000, 1000, 400)),
      });
      const refund = await world.expense({
        amount: -300,
        refundOfId: source.id,
        financialBreakdown: JSON.stringify(breakdown(0, -300, -300)),
      });
      const fresh = await world.expenses.get(
        { id: source.id },
        { cache: false },
      );
      if (!fresh) throw new Error('Missing source');
      fresh.setFinancialBreakdown(breakdown(10000, 1000, 200));
      await expect(fresh.save()).rejects.toMatchObject({
        code: 'EXPENSE_INVALID',
      });
      const other = await world.expense({ amount: 200 });
      refund.refundOfId = other.id;
      await expect(refund.save()).rejects.toMatchObject({
        code: 'EXPENSE_INVALID',
      });
      expect(
        (await world.expenses.refundPosition(source.id)).refundedAmount,
      ).toBe(300);
      expect(
        (await world.expenses.refundPosition(other.id)).refundedAmount,
      ).toBe(0);
    });
  });

  it('rolls back a cap-relevant edit and its source revision with the caller transaction', async () => {
    const world = getWorld();
    await world.inTenant(async () => {
      const source = await world.expense({ amount: 1000 });
      const refund = await world.expense({
        amount: -100,
        refundOfId: source.id,
      });
      const before = await world.expenses.get(
        { id: source.id },
        { cache: false },
      );
      if (!world.db.transaction) throw new Error('Transactions required');
      await expect(
        world.db.transaction(async (tx) => {
          const expenses = await ExpenseCollection.create({ db: tx });
          const loaded = await expenses.get(
            { id: refund.id },
            { cache: false },
          );
          if (!loaded) throw new Error('Missing refund');
          loaded.amount = -900;
          await loaded.save();
          expect(
            (await expenses.refundPosition(source.id)).remainingAmount,
          ).toBe(100);
          throw new Error('refund-edit rollback');
        }),
      ).rejects.toThrow('refund-edit rollback');
      const after = await world.expenses.get(
        { id: source.id },
        { cache: false },
      );
      expect(after?.updated_at).toEqual(before?.updated_at);
      expect(
        (await world.expenses.refundPosition(source.id)).remainingAmount,
      ).toBe(900);
    });
  });
}
