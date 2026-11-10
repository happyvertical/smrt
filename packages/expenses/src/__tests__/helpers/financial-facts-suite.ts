/** Financial source-fact behavior, executed unchanged on SQLite and PostgreSQL. */
import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { describe, expect, it } from 'vitest';
import { ExpenseCollection } from '../../collections/ExpenseCollection.js';
import type { ExpenseFinancialBreakdown, ExpenseOptions } from '../../types.js';
import { createWorld, type ExpenseWorld } from './expense-suite.js';

const facts = (): ExpenseFinancialBreakdown => ({
  currency: 'USD',
  subtotal: 10000,
  taxes: [{ code: 'supplier-tax', amount: 1000, recoverableAmount: 400 }],
  total: 11000,
});

/** Register financial facts against the enclosing suite's tenant and database. */
export function defineFinancialFactsSuite(getWorld: () => ExpenseWorld): void {
  describe('optional financial source facts', () => {
    it('preserves unknown legacy facts and roundtrips an explicit partially recoverable basis', async () => {
      const world = getWorld();
      await world.inTenant(async () => {
        const legacy = await world.expense();
        const old = await world.expenses.get({ id: legacy.id });
        expect(old?.getFinancialBreakdown()).toBeNull();
        expect(old?.getCostBasis()).toBeNull();
        const expense = await world.expense({ amount: 11000 });
        expense.setFinancialBreakdown(facts());
        await expense.save();
        const loaded = await world.expenses.get({ id: expense.id });
        expect(loaded?.getFinancialBreakdown()).toEqual(facts());
        expect(loaded?.getCostBasis()).toEqual({
          currency: 'USD',
          subtotal: 10000,
          taxTotal: 1000,
          recoverableTax: 400,
          nonRecoverableTax: 600,
          total: 11000,
          costBasis: 10600,
        });
        // A caller cannot mutate the stored JSON by modifying a returned object.
        loaded!.getFinancialBreakdown()!.taxes[0].amount = 9;
        expect(loaded?.getCostBasis()?.costBasis).toBe(10600);
        loaded!.setFinancialBreakdown(null);
        await loaded!.save();
        expect(
          (await world.expenses.get({ id: expense.id }))?.getCostBasis(),
        ).toBeNull();
      });
    });

    it('rejects malformed, unknown, incoherent, unsafe and duplicate financial facts before persistence', async () => {
      const world = getWorld();
      await world.inTenant(async () => {
        const good = facts();
        const bad: unknown[] = [
          null,
          [],
          {},
          { ...good, surprise: true },
          { ...good, currency: 'EUR' },
          { ...good, currency: 'usd' },
          { ...good, total: 11001 },
          { ...good, subtotal: 9999 },
          { ...good, subtotal: -10000 },
          { ...good, subtotal: 10000.5 },
          { ...good, subtotal: Number.MAX_SAFE_INTEGER + 1 },
          { ...good, subtotal: '10000' },
          { ...good, taxes: null },
          { ...good, taxes: [good.taxes[0], good.taxes[0]] },
          ...[
            { code: '' },
            { code: 'Tax' },
            { code: 'x', extra: true },
            { amount: -1000 },
            { recoverableAmount: 1001 },
            { recoverableAmount: -1 },
            { recoverableAmount: undefined },
            { amount: Number.MAX_SAFE_INTEGER + 1 },
          ].map((patch) => ({
            ...good,
            taxes: [{ ...good.taxes[0], ...patch }],
          })),
        ];
        const expense = await world.expense({ amount: 11000 });
        for (const value of bad) {
          expense.financialBreakdown = JSON.stringify(value);
          await expect(expense.save()).rejects.toMatchObject({
            code: 'EXPENSE_INVALID',
          });
        }
        expense.financialBreakdown = '{broken';
        await expect(expense.save()).rejects.toMatchObject({
          code: 'EXPENSE_INVALID',
        });
        expect(
          (await world.expenses.get({ id: expense.id }))?.getCostBasis(),
        ).toBeNull();
        expense.setFinancialBreakdown(good);
        await expense.save();
        await expense.save();
        expect(
          (await world.expenses.get({ id: expense.id }))?.getCostBasis()
            ?.costBasis,
        ).toBe(10600);
      });
    });

    it('rejects recovery against zero tax on refunds without changing stored facts', async () => {
      const world = getWorld();
      await world.inTenant(async () => {
        const source = await world.expense({ amount: 100 });
        const refund = await world.expense({
          amount: -100,
          refundOfId: source.id,
        });
        const invalid: ExpenseFinancialBreakdown = {
          currency: 'USD',
          subtotal: -100,
          total: -100,
          taxes: [{ code: 'supplier-tax', amount: 0, recoverableAmount: -1 }],
        };
        expect(() => refund.setFinancialBreakdown(invalid)).toThrow(
          'recovery bounded by tax',
        );
        refund.financialBreakdown = JSON.stringify(invalid);
        await expect(refund.save()).rejects.toMatchObject({
          code: 'EXPENSE_INVALID',
        });
        expect(
          (await world.expenses.get({ id: refund.id }))?.getCostBasis(),
        ).toBeNull();
        invalid.taxes[0].recoverableAmount = 0;
        refund.setFinancialBreakdown(invalid);
        await refund.save();
        expect(
          (await world.expenses.get({ id: refund.id }))?.getCostBasis(),
        ).toMatchObject({
          recoverableTax: 0,
          nonRecoverableTax: 0,
          costBasis: -100,
        });
      });
    });

    it('revalidates facts against changed amount and currency and does not partially save', async () => {
      const world = getWorld();
      await world.inTenant(async () => {
        const expense = await world.expense({
          amount: 11000,
          financialBreakdown: JSON.stringify(facts()),
        });
        expense.amount = 11001;
        await expect(expense.save()).rejects.toMatchObject({
          code: 'EXPENSE_INVALID',
        });
        expense.amount = 11000;
        expense.currency = 'EUR';
        await expect(expense.save()).rejects.toMatchObject({
          code: 'EXPENSE_INVALID',
        });
        const loaded = await world.expenses.get({ id: expense.id });
        expect(loaded?.getCostBasis()).toMatchObject({
          total: 11000,
          currency: 'USD',
        });
        expense.currency = 'USD';
        await expense.save();
      });
    });

    it('supports zero tax and maximum safe exact values without rounding', async () => {
      const world = getWorld();
      await world.inTenant(async () => {
        for (const amount of [
          0,
          Number.MAX_SAFE_INTEGER,
          -Number.MAX_SAFE_INTEGER,
        ]) {
          const source =
            amount < 0 ? await world.expense({ amount: -amount }) : null;
          const expense = await world.expense({
            amount,
            refundOfId: source?.id ?? null,
          });
          expense.setFinancialBreakdown({
            currency: 'USD',
            subtotal: amount,
            taxes: [],
            total: amount,
          });
          await expense.save();
          expect(
            (await world.expenses.get({ id: expense.id }))?.getCostBasis()
              ?.costBasis,
          ).toBe(amount);
        }
      });
    });

    it('requires a named third-party payer and refuses employee reimbursement semantics', async () => {
      const world = getWorld();
      await world.inTenant(async () => {
        const expense = await world.expense({
          paidBy: 'third-party',
          paidByName: 'Synthetic funder',
        });
        const loaded = await world.expenses.get({ id: expense.id });
        expect(loaded?.paidByName).toBe('Synthetic funder');
        expect(loaded?.reimbursable).toBe(false);
        await expect(loaded!.markReimbursed()).rejects.toMatchObject({
          code: 'EXPENSE_INVALID',
        });
        for (const patch of [
          { paidBy: 'third-party' },
          { paidBy: 'third-party', paidByName: ' ' },
          { paidBy: 'third-party', paidByName: 'Funder', reimbursable: true },
          {
            paidBy: 'third-party',
            paidByName: 'Funder',
            paidByProfileId: randomUUID(),
          },
          { paidBy: 'company', paidByName: 'Funder' },
          {
            paidBy: 'person',
            paidByName: 'Funder',
            paidByProfileId: randomUUID(),
          },
          { paidBy: 'unknown' },
        ]) {
          await expect(
            world.expense(patch as ExpenseOptions),
          ).rejects.toMatchObject({ code: 'EXPENSE_INVALID' });
        }
      });
    });

    it('requires same-owner same-currency positive refund provenance and derives signed refund basis', async () => {
      const world = getWorld();
      const other = await createWorld(world.db);
      const foreign = await other.inTenant(() => other.expense());
      const global = await world.expense();
      await world.inTenant(async () => {
        const source = await world.expense({ amount: 11000 });
        const refund = await world.expense({
          amount: -1100,
          refundOfId: source.id,
        });
        refund.setFinancialBreakdown({
          currency: 'USD',
          subtotal: -1000,
          taxes: [
            { code: 'supplier-tax', amount: -100, recoverableAmount: -40 },
          ],
          total: -1100,
        });
        await refund.save();
        expect(
          (await world.expenses.get({ id: refund.id }))?.getCostBasis()
            ?.costBasis,
        ).toBe(-1060);
        for (const patch of [
          { refundOfId: foreign.id },
          { refundOfId: global.id },
          { refundOfId: randomUUID() },
          { refundOfId: refund.id },
          { refundOfId: source.id, currency: 'EUR' },
          { refundOfId: source.id, amount: 100 },
          { refundOfId: source.id, amount: 0 },
        ]) {
          await expect(
            world.expense({ amount: -100, ...patch }),
          ).rejects.toMatchObject({ code: 'EXPENSE_INVALID' });
        }
        await expect(
          (await world.expenses.get(
            { id: source.id },
            { cache: false },
          ))!.delete(),
        ).rejects.toThrow();
        expect(await world.expenses.get({ id: source.id })).not.toBeNull();
        refund.refundOfId = refund.id;
        await expect(refund.save()).rejects.toMatchObject({
          code: 'EXPENSE_INVALID',
        });
        expect((await world.expenses.get({ id: refund.id }))?.refundOfId).toBe(
          source.id,
        );
      });
    });

    it.each([
      'unreviewed',
      'reopened',
    ] as const)('preserves inbound reviewed refunds when the source is %s', async (state) => {
      const world = getWorld();
      await world.inTenant(async () => {
        const source = await world.expense({ amount: 1000 });
        const another = await world.expense({ amount: 2000 });
        const reviewerProfileId = randomUUID();
        if (state === 'reopened') {
          await source.review({ reviewerProfileId });
          await source.reopen({ reviewerProfileId });
        }
        const refund = await world.expense({
          amount: -100,
          refundOfId: source.id,
        });
        await refund.review({ reviewerProfileId });
        for (const patch of [
          { currency: 'EUR' },
          { amount: 0 },
          { amount: -100, refundOfId: another.id },
        ]) {
          const loaded = (await world.expenses.get({ id: source.id }))!;
          Object.assign(loaded, patch);
          await expect(loaded.save()).rejects.toMatchObject({
            code: 'EXPENSE_INVALID',
          });
          expect(await world.expenses.get({ id: source.id })).toMatchObject({
            amount: 1000,
            currency: 'USD',
            refundOfId: null,
          });
          expect(await world.expenses.get({ id: refund.id })).toMatchObject({
            amount: -100,
            currency: 'USD',
            refundOfId: source.id,
            reviewStatus: 'reviewed',
          });
        }
        const freshSource = (await world.expenses.get(
          { id: source.id },
          { cache: false },
        ))!;
        freshSource.description = 'Corrected description';
        await freshSource.save();
        freshSource.amount = 1200;
        await freshSource.save();
        expect(await world.expenses.get({ id: source.id })).toMatchObject({
          description: 'Corrected description',
          amount: 1200,
        });
        another.amount = 0;
        another.currency = 'EUR';
        await another.save();
      });
    });

    it('scopes inbound refund checks to the source owner even outside an active context', async () => {
      const world = getWorld();
      const other = await createWorld(world.db);
      const source = await world.inTenant(() =>
        world.expense({ amount: 1000 }),
      );
      const foreignSource = await other.inTenant(() =>
        other.expense({ amount: 1000 }),
      );
      const foreignRefund = await other.inTenant(() =>
        other.expense({ amount: -100, refundOfId: foreignSource.id }),
      );
      // Simulate a malformed legacy row without weakening the public write path.
      await world.db.query(
        'UPDATE expenses SET refund_of_id = ? WHERE id = ?',
        source.id,
        foreignRefund.id,
      );
      source.currency = 'EUR';
      await source.save();
      expect((await world.expenses.get({ id: source.id }))?.currency).toBe(
        'EUR',
      );
      const ownRefund = await world.inTenant(() =>
        world.expense({ amount: -100, currency: 'EUR', refundOfId: source.id }),
      );
      source.amount = 0;
      await expect(source.save()).rejects.toMatchObject({
        code: 'EXPENSE_INVALID',
      });
      expect((await world.expenses.get({ id: ownRefund.id }))?.refundOfId).toBe(
        source.id,
      );
      const global = await world.expense({ amount: 1000 });
      const globalRefund = await world.expense({
        amount: -100,
        refundOfId: global.id,
      });
      global.currency = 'EUR';
      await expect(global.save()).rejects.toMatchObject({
        code: 'EXPENSE_INVALID',
      });
      expect(
        (await world.expenses.get({ id: globalRefund.id }))?.currency,
      ).toBe('USD');
    });

    it('checks uncommitted inbound refunds on the caller executor and rolls back together', async () => {
      const world = getWorld();
      const transactional = world.db as DatabaseInterface & {
        transaction<T>(work: (tx: DatabaseInterface) => Promise<T>): Promise<T>;
      };
      await world.inTenant(async () => {
        const source = await world.expense({ amount: 1000 });
        let refundId: string | null = null;
        await expect(
          transactional.transaction(async (tx) => {
            const expenses = await ExpenseCollection.create({ db: tx });
            const refund = await expenses.create({
              amount: -100,
              currency: 'USD',
              incurredOn: '2026-10-01',
              refundOfId: source.id,
            });
            refundId = refund.id ?? null;
            const loaded = (await expenses.get({ id: source.id }))!;
            loaded.currency = 'EUR';
            await loaded.save();
          }),
        ).rejects.toMatchObject({ code: 'EXPENSE_INVALID' });
        expect(await world.expenses.get({ id: refundId })).toBeNull();
        expect(await world.expenses.get({ id: source.id })).toMatchObject({
          amount: 1000,
          currency: 'USD',
        });
        source.currency = 'EUR';
        await source.save();
        expect((await world.expenses.get({ id: source.id }))?.currency).toBe(
          'EUR',
        );
      });
    });

    it('freezes every new fact when reviewed, including alongside reopen, then permits explicit correction', async () => {
      const world = getWorld();
      await world.inTenant(async () => {
        const source = await world.expense({ amount: 11000 });
        const anotherSource = await world.expense({ amount: 11000 });
        const expense = await world.expense({
          amount: -11000,
          refundOfId: source.id,
          paidBy: 'third-party',
          paidByName: 'Synthetic funder',
        });
        expense.setFinancialBreakdown({
          currency: 'USD',
          subtotal: -10000,
          taxes: [
            { code: 'supplier-tax', amount: -1000, recoverableAmount: -400 },
          ],
          total: -11000,
        });
        const reviewerProfileId = randomUUID();
        await expense.review({ reviewerProfileId });
        for (const patch of [
          { financialBreakdown: '' },
          { paidByName: 'Another funder' },
          { refundOfId: anotherSource.id },
        ]) {
          const loaded = (await world.expenses.get({ id: expense.id }))!;
          Object.assign(loaded, patch);
          await expect(loaded.save()).rejects.toMatchObject({
            code: 'EXPENSE_REVIEW_FIELDS_LOCKED',
          });
          await expect(
            loaded.reopen({ reviewerProfileId }),
          ).rejects.toMatchObject({ code: 'EXPENSE_REVIEW_FIELDS_LOCKED' });
          expect(loaded.reviewStatus).toBe('reviewed');
        }
        const loaded = (await world.expenses.get({ id: expense.id }))!;
        await loaded.reopen({ reviewerProfileId });
        loaded.paidByName = 'Corrected funder';
        loaded.setFinancialBreakdown(null);
        await expect(loaded.save()).rejects.toMatchObject({
          code: 'EXPENSE_INVALID',
        });
        loaded.setFinancialBreakdown(expense.getFinancialBreakdown());
        await loaded.save();
        await loaded.review({ reviewerProfileId });
        expect((await world.expenses.get({ id: expense.id }))?.paidByName).toBe(
          'Corrected funder',
        );
      });
    });

    it('keeps reviewed totals and commitment drawdown on signed gross amounts, not retained basis', async () => {
      const world = getWorld();
      await world.inTenant(async () => {
        const commitment = await world.commitment(11000);
        const source = await world.expense({
          amount: 11000,
          commitmentId: commitment.id,
          financialBreakdown: JSON.stringify(facts()),
        });
        const refund = await world.expense({
          amount: -1100,
          commitmentId: commitment.id,
          refundOfId: source.id,
        });
        refund.setFinancialBreakdown({
          currency: 'USD',
          subtotal: -1000,
          taxes: [
            { code: 'supplier-tax', amount: -100, recoverableAmount: -40 },
          ],
          total: -1100,
        });
        const reviewerProfileId = randomUUID();
        await (await world.expenses.get(
          { id: source.id },
          { cache: false },
        ))!.review({ reviewerProfileId });
        await refund.review({ reviewerProfileId });
        expect(await world.expenses.totalsByCurrency()).toEqual({
          USD: { amount: 9900, count: 2 },
        });
        const position = await world.expenses.commitmentPosition(commitment.id);
        expect(position).toMatchObject({ drawn: 9900, open: 1100, overrun: 0 });
        expect(position.countedExpenseIds).toEqual(
          [source.id, refund.id].sort(),
        );
      });
    });

    it('keeps source lookup on the caller transaction and rolls back new source and refund together', async () => {
      const world = getWorld();
      const transactional = world.db as DatabaseInterface & {
        transaction<T>(work: (tx: DatabaseInterface) => Promise<T>): Promise<T>;
      };
      await world.inTenant(async () => {
        const ids: string[] = [];
        const run = async (fail: boolean) =>
          transactional.transaction(async (tx) => {
            const expenses = await ExpenseCollection.create({ db: tx });
            const source = await expenses.create({
              amount: 1000,
              currency: 'USD',
              incurredOn: '2026-10-01',
            });
            await source.save();
            ids.push(source.id!);
            const refund = await expenses.create({
              amount: -100,
              currency: 'USD',
              incurredOn: '2026-10-02',
              refundOfId: source.id,
            });
            refund.setFinancialBreakdown({
              currency: 'USD',
              subtotal: -100,
              taxes: [],
              total: -100,
            });
            await refund.save();
            ids.push(refund.id!);
            if (fail) throw new Error('synthetic rollback');
          });
        await expect(run(true)).rejects.toThrow('synthetic rollback');
        for (const id of ids)
          expect(await world.expenses.get({ id })).toBeNull();
        await run(false);
        expect(
          (await world.expenses.get({ id: ids[3] }))?.getCostBasis()?.costBasis,
        ).toBe(-100);
      });
    });
  });
}
