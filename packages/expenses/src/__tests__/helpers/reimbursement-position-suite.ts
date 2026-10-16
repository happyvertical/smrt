/** Shared adapter contract for cash direction and exact remaining reimbursement. */
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { ExpenseCollection } from '../../collections/ExpenseCollection.js';
import type { ExpenseWorld } from './expense-suite.js';

export function defineReimbursementPositionSuite(
  getWorld: () => ExpenseWorld,
): void {
  it.each([
    'company',
    'person',
  ] as const)('records whole remaining claim after %s receives a refund', async (kind) => {
    const world = getWorld();
    await world.inTenant(async () => {
      const profileId = randomUUID();
      const source = await world.expense({
        amount: 11000,
        paidBy: 'person',
        paidByProfileId: profileId,
        reimbursable: true,
        financialBreakdown: JSON.stringify({
          currency: 'USD',
          subtotal: 10000,
          taxes: [{ code: 'tax', amount: 1000, recoverableAmount: 400 }],
          total: 11000,
        }),
      });
      await world.expense({
        amount: -2000,
        refundOfId: source.id,
        refundRecipient: JSON.stringify(
          kind === 'company' ? { kind } : { kind, profileId },
        ),
      });
      const remaining = kind === 'company' ? 11000 : 9000;
      expect(
        await world.expenses.reimbursementPosition(source.id),
      ).toMatchObject({
        sourceAmount: 11000,
        remainingAmount: remaining,
        owedToCompany: 0,
        reimbursedAmount: 0,
        unknownReason: null,
      });
      const fresh = await world.expenses.get(
        { id: source.id },
        { cache: false },
      );
      if (!fresh) throw new Error('Missing source');
      await expect(
        fresh.markReimbursed({ amount: remaining - 1 }),
      ).rejects.toMatchObject({ code: 'EXPENSE_INVALID' });
      await fresh.markReimbursed({
        amount: remaining,
        reference: 'exact-cash',
      });
      const stored = await world.expenses.get(
        { id: source.id },
        { cache: false },
      );
      expect(stored).toMatchObject({
        amount: 11000,
        reimbursedAmount: remaining,
        reimbursementReference: 'exact-cash',
      });
      expect(stored?.getCostBasis()?.costBasis).toBe(10600);
      expect(
        await world.expenses.reimbursementPosition(source.id),
      ).toMatchObject({
        remainingAmount: 0,
        owedToCompany: 0,
        reimbursedAmount: remaining,
      });
      await expect(
        stored?.markReimbursed({ amount: remaining, reference: 'different' }),
      ).rejects.toMatchObject({ code: 'EXPENSE_INVALID' });
    });
  });

  it('exposes later person refunds as a company receivable without altering paid cash', async () => {
    const world = getWorld();
    await world.inTenant(async () => {
      const profileId = randomUUID();
      const source = await world.expense({
        amount: 1000,
        paidBy: 'person',
        paidByProfileId: profileId,
        reimbursable: true,
      });
      await source.markReimbursed({ amount: 1000, reference: 'paid' });
      await world.expense({
        amount: -200,
        refundOfId: source.id,
        refundRecipient: JSON.stringify({ kind: 'person', profileId }),
      });
      expect(
        await world.expenses.reimbursementPosition(source.id),
      ).toMatchObject({
        sourceAmount: 1000,
        personRefundAmount: 200,
        reimbursedAmount: 1000,
        remainingAmount: 0,
        owedToCompany: 200,
      });
      const loaded = await world.expenses.get(
        { id: source.id },
        { cache: false },
      );
      if (!loaded) throw new Error('Missing source');
      loaded.reimbursedAmount = 800;
      await expect(loaded.save()).rejects.toMatchObject({
        code: 'EXPENSE_INVALID',
      });
      loaded.reimbursedAmount = 1000;
      loaded.amount = 900;
      await expect(loaded.save()).rejects.toMatchObject({
        code: 'EXPENSE_INVALID',
      });
      expect(
        (await world.expenses.get({ id: source.id }))?.reimbursedAmount,
      ).toBe(1000);
    });
  });

  it.each([
    'unknown',
    'another-person',
  ] as const)('keeps %s refund direction unknown and refuses payment', async (recipient) => {
    const world = getWorld();
    await world.inTenant(async () => {
      const source = await world.expense({
        amount: 1000,
        paidBy: 'person',
        paidByProfileId: randomUUID(),
        reimbursable: true,
      });
      await world.expense({
        amount: -100,
        refundOfId: source.id,
        ...(recipient === 'another-person'
          ? {
              refundRecipient: JSON.stringify({
                kind: 'person',
                profileId: randomUUID(),
              }),
            }
          : {}),
      });
      expect(
        await world.expenses.reimbursementPosition(source.id),
      ).toMatchObject({
        remainingAmount: null,
        owedToCompany: null,
        unknownReason:
          recipient === 'unknown'
            ? 'unknown-refund-recipient'
            : 'recipient-is-another-person',
      });
      const fresh = await world.expenses.get(
        { id: source.id },
        { cache: false },
      );
      await expect(fresh?.markReimbursed()).rejects.toMatchObject({
        code: 'EXPENSE_INVALID',
      });
    });
  });

  it('preserves unknown historical payment amount instead of inferring original gross', async () => {
    const world = getWorld();
    await world.inTenant(async () => {
      const source = await world.expense({
        amount: 1000,
        paidBy: 'person',
        paidByProfileId: randomUUID(),
        reimbursable: true,
      });
      // Deliberate fixture of a pre-contract row; model writes cannot forge markers.
      await world.db.query(
        'UPDATE expenses SET reimbursed_at = ? WHERE id = ?',
        new Date('2026-10-01').toISOString(),
        source.id,
      );
      expect(
        await world.expenses.reimbursementPosition(source.id),
      ).toMatchObject({
        reimbursedAmount: null,
        remainingAmount: null,
        owedToCompany: null,
        unknownReason: 'legacy-reimbursement-amount',
      });
      const loaded = await world.expenses.get(
        { id: source.id },
        { cache: false },
      );
      await expect(loaded?.markReimbursed()).rejects.toMatchObject({
        code: 'EXPENSE_INVALID',
      });
      if (!loaded) throw new Error('Missing source');
      loaded.description = 'Unrelated description remains editable';
      await loaded.save();
    });
  });

  it('guards recipient shape and reviewed provenance, and rolls payment back with caller transaction', async () => {
    const world = getWorld();
    await world.inTenant(async () => {
      const source = await world.expense({
        amount: 1000,
        paidBy: 'person',
        paidByProfileId: randomUUID(),
        reimbursable: true,
      });
      await expect(
        world.expense({ amount: 100, refundRecipient: '{"kind":"company"}' }),
      ).rejects.toMatchObject({ code: 'EXPENSE_INVALID' });
      await expect(
        world.expense({
          amount: -100,
          refundOfId: source.id,
          refundRecipient: '{"kind":"person","profileId":"bad"}',
        }),
      ).rejects.toMatchObject({ code: 'EXPENSE_INVALID' });
      const refund = await world.expense({
        amount: -100,
        refundOfId: source.id,
        refundRecipient: '{"kind":"company"}',
      });
      await refund.review({ reviewerProfileId: randomUUID() });
      refund.setRefundRecipient({
        kind: 'person',
        profileId: source.paidByProfileId as string,
      });
      await expect(refund.save()).rejects.toMatchObject({
        code: 'EXPENSE_REVIEW_FIELDS_LOCKED',
      });
      if (!world.db.transaction) throw new Error('Transactions required');
      await expect(
        world.db.transaction(async (tx) => {
          const expenses = await ExpenseCollection.create({ db: tx });
          const loaded = await expenses.get(
            { id: source.id },
            { cache: false },
          );
          if (!loaded) throw new Error('Missing source');
          await loaded.markReimbursed({
            amount: 1000,
            reference: 'rolled-back',
          });
          throw new Error('payment rollback');
        }),
      ).rejects.toThrow('payment rollback');
      expect(
        await world.expenses.reimbursementPosition(source.id),
      ).toMatchObject({ reimbursedAmount: 0, remainingAmount: 1000 });
      const loaded = await world.expenses.get(
        { id: source.id },
        { cache: false },
      );
      if (!loaded) throw new Error('Missing source');
      loaded.reimbursedAt = new Date();
      loaded.reimbursedAmount = 1000;
      await expect(loaded.save()).rejects.toMatchObject({
        code: 'EXPENSE_INVALID',
      });
    });
  });
}
