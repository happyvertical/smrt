/**
 * The expense behaviour suite, shared by the default (SQLite) lane and the
 * PostgreSQL lane so both adapters prove the same contract: review
 * transitions, duplicate receipts, and commitment matching.
 *
 * Every test runs inside its own fresh tenant, with tenancy enabled, so the
 * PostgreSQL lane can share one migrated database across tests.
 */

import { randomUUID } from 'node:crypto';
import { AssetCollection } from '@happyvertical/smrt-assets';
import {
  ContractCollection,
  ContractLineItemCollection,
  VendorCollection,
} from '@happyvertical/smrt-commerce';
import { GlobalInterceptors, SmrtObject } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExpenseCollection } from '../../collections/ExpenseCollection.js';
import { ExpenseReceiptCollection } from '../../collections/ExpenseReceiptCollection.js';
import { Expense } from '../../models/Expense.js';
import { ExpenseReceipt } from '../../models/ExpenseReceipt.js';
import {
  DuplicateReceiptError,
  type ExpenseError,
  type ExpenseOptions,
} from '../../types.js';
import { computeContentSha256 } from '../../validation.js';

export const PROJECT = '@happyvertical/smrt-projects:Project';

/** A persisted object: its id is known. */
export type Saved<T> = T & { id: string };

function saved<T extends { id?: string | null }>(object: T): Saved<T> {
  if (!object.id) throw new Error('expected a persisted object with an id');
  return object as Saved<T>;
}

/** Collections bound to one database, plus a fresh tenant to work in. */
export interface ExpenseWorld {
  db: DatabaseInterface;
  tenantId: string;
  expenses: ExpenseCollection;
  receipts: ExpenseReceiptCollection;
  contracts: ContractCollection;
  lines: ContractLineItemCollection;
  assets: AssetCollection;
  /** Run `fn` inside this world's tenant. */
  inTenant<T>(fn: () => Promise<T>): Promise<T>;
  /** Create and save an expense with sensible defaults. */
  expense(overrides?: ExpenseOptions): Promise<Saved<Expense>>;
  /** Create and save an asset. */
  asset(name?: string): Promise<{ id: string }>;
  /** Create and save a purchase-order commitment. */
  commitment(totalAmount: number, currency?: string): Promise<{ id: string }>;
  /** Create and save a commerce vendor. */
  vendor(): Promise<{ id: string }>;
}

/** Build a world over `db` with its own tenant. */
export async function createWorld(
  db: DatabaseInterface,
): Promise<ExpenseWorld> {
  const tenantId = randomUUID();
  const expenses = await ExpenseCollection.create({ db });
  const receipts = await ExpenseReceiptCollection.create({ db });
  const contracts = await ContractCollection.create({ db });
  const lines = await ContractLineItemCollection.create({ db });
  const assets = await AssetCollection.create({ db });
  const world: ExpenseWorld = {
    db,
    tenantId,
    expenses,
    receipts,
    contracts,
    lines,
    assets,
    inTenant: (fn) => withTenant({ tenantId }, fn),
    async expense(overrides = {}) {
      const expense = await expenses.create({
        costObjectType: PROJECT,
        costObjectId: 'project-1',
        category: 'material',
        description: 'Lumber',
        amount: 10000,
        currency: 'USD',
        incurredOn: '2026-09-15',
        recordedByProfileId: randomUUID(),
        ...overrides,
      });
      await expense.save();
      return saved(expense);
    },
    async asset(name = 'receipt.pdf') {
      const asset = await assets.create({
        name,
        mimeType: 'application/pdf',
        sourceUri: `file:///receipts/${randomUUID()}.pdf`,
      });
      await asset.save();
      return saved(asset);
    },
    async commitment(totalAmount, currency = 'USD') {
      const po = await contracts.create({
        _meta_type: 'PurchaseOrder',
        totalAmount,
        subtotal: totalAmount,
        currency,
        reference: `PO-${randomUUID().slice(0, 8)}`,
      } as never);
      await po.save();
      return saved(po);
    },
    async vendor() {
      const vendors = await VendorCollection.create({ db });
      const vendor = await vendors.create({ profileId: randomUUID() });
      await vendor.save();
      return saved(vendor);
    },
  };
  return world;
}

/**
 * Attach a receipt in `world`'s tenant, then move that row out of the
 * tenant's reads (raw `tenant_id = NULL`). A second attach of the same file
 * then passes the tenant-filtered pre-insert read and reaches the unique
 * index — the same path a concurrent attach takes.
 */
export async function hideReceiptFromTenantReads(
  world: ExpenseWorld,
): Promise<{ expenseId: string; sha: string }> {
  const sha = computeContentSha256(`hidden-${randomUUID()}`);
  const { expenseId, receiptId } = await world.inTenant(async () => {
    const expense = await world.expense();
    const receipt = await world.receipts.attachReceipt({
      expenseId: expense.id,
      assetId: (await world.asset()).id,
      contentSha256: sha,
    });
    return { expenseId: expense.id, receiptId: String(receipt.id) };
  });
  await world.db.query(
    'UPDATE expense_receipts SET tenant_id = NULL WHERE id = ?',
    receiptId,
  );
  return { expenseId, sha };
}

async function expectExpenseError(
  promise: Promise<unknown>,
  code: ExpenseError['code'],
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

/**
 * Register the behaviour suite against whatever database `getDb()` returns
 * when a test runs.
 */
export function defineExpenseSuite(getDb: () => DatabaseInterface): void {
  let world: ExpenseWorld;

  beforeEach(async () => {
    enableTenancy();
    world = await createWorld(getDb());
  });

  afterEach(() => {
    disableTenancy();
  });

  describe('recording', () => {
    it('stores integer minor units, the incurred date, and recordedAt', async () => {
      await world.inTenant(async () => {
        const expense = await world.expense({ amount: 1999 });
        const loaded = await world.expenses.get({ id: expense.id });
        expect(loaded?.amount).toBe(1999);
        expect(Number.isSafeInteger(loaded?.amount)).toBe(true);
        expect(loaded?.currency).toBe('USD');
        expect(loaded?.incurredOn).toBe('2026-09-15');
        expect(loaded?.recordedAt).toBeInstanceOf(Date);
        expect(loaded?.tenantId).toBe(world.tenantId);
        expect(loaded?.reviewStatus).toBe('unreviewed');
      });
    });

    it('refuses fractional money, bad currency, and bad dates', async () => {
      await world.inTenant(async () => {
        await expectExpenseError(
          world.expense({ amount: 19.99 }),
          'EXPENSE_INVALID',
        );
        await expectExpenseError(
          world.expense({ currency: 'usd$' }),
          'EXPENSE_INVALID',
        );
        await expectExpenseError(
          world.expense({ incurredOn: '2026-02-30' }),
          'EXPENSE_INVALID',
        );
        await expectExpenseError(
          world.expense({ costObjectType: 'Project' }),
          'EXPENSE_INVALID',
        );
        await expectExpenseError(
          world.expense({ costObjectId: '' }),
          'EXPENSE_INVALID',
        );
      });
    });

    it('requires a named person for an out-of-pocket expense', async () => {
      await world.inTenant(async () => {
        await expectExpenseError(
          world.expense({ paidBy: 'person' }),
          'EXPENSE_INVALID',
        );
        await expectExpenseError(
          world.expense({ reimbursable: true }),
          'EXPENSE_INVALID',
        );
        const payer = randomUUID();
        const expense = await world.expense({
          paidBy: 'person',
          paidByProfileId: payer,
          reimbursable: true,
        });
        expect(expense.paidByProfileId).toBe(payer);
        expect(expense.isReimbursed()).toBe(false);
      });
    });
  });

  describe('review transitions', () => {
    it('reviews an unreviewed expense with reviewer and time', async () => {
      await world.inTenant(async () => {
        const expense = await world.expense();
        const reviewer = randomUUID();
        const at = new Date('2026-09-20T10:00:00.000Z');
        await expense.review({ reviewerProfileId: reviewer, at, note: 'ok' });

        const loaded = await world.expenses.get({ id: expense.id });
        expect(loaded?.reviewStatus).toBe('reviewed');
        expect(loaded?.reviewedByProfileId).toBe(reviewer);
        expect(loaded?.reviewedAt?.toISOString()).toBe(at.toISOString());
        expect(loaded?.reviewNote).toBe('ok');
      });
    });

    it('allows only the documented moves', async () => {
      await world.inTenant(async () => {
        const reviewer = randomUUID();
        const expense = await world.expense();

        await expectExpenseError(
          expense.reopen({ reviewerProfileId: reviewer }),
          'EXPENSE_REVIEW_TRANSITION',
        );
        await expense.review({ reviewerProfileId: reviewer });
        await expectExpenseError(
          expense.review({ reviewerProfileId: reviewer }),
          'EXPENSE_REVIEW_TRANSITION',
        );
        await expense.reject({
          reviewerProfileId: reviewer,
          reason: 'personal',
        });
        expect(expense.reviewStatus).toBe('rejected');
        await expectExpenseError(
          expense.reject({ reviewerProfileId: reviewer, reason: 'again' }),
          'EXPENSE_REVIEW_TRANSITION',
        );
        await expectExpenseError(
          expense.review({ reviewerProfileId: reviewer }),
          'EXPENSE_REVIEW_TRANSITION',
        );
        await expense.reopen({ reviewerProfileId: reviewer });
        expect(expense.reviewStatus).toBe('unreviewed');
        expect(expense.reviewedByProfileId).toBeNull();
        await expense.review({ reviewerProfileId: reviewer });
        expect(
          (await world.expenses.get({ id: expense.id }))?.reviewStatus,
        ).toBe('reviewed');
      });
    });

    it('needs a reviewer and a rejection reason', async () => {
      await world.inTenant(async () => {
        const expense = await world.expense();
        await expectExpenseError(
          expense.review({ reviewerProfileId: '' }),
          'EXPENSE_INVALID',
        );
        await expectExpenseError(
          expense.reject({ reviewerProfileId: randomUUID(), reason: ' ' }),
          'EXPENSE_INVALID',
        );
        expect(expense.reviewStatus).toBe('unreviewed');
      });
    });

    it('refuses review state written as a plain field', async () => {
      await world.inTenant(async () => {
        await expectExpenseError(
          world.expense({ reviewStatus: 'reviewed' } as ExpenseOptions),
          'EXPENSE_REVIEW_FIELDS_LOCKED',
        );

        const expense = await world.expense();
        const loaded = await world.expenses.get({ id: expense.id });
        if (!loaded) throw new Error('expense not loaded');
        loaded.reviewStatus = 'reviewed';
        loaded.reviewedByProfileId = randomUUID();
        await expectExpenseError(loaded.save(), 'EXPENSE_REVIEW_FIELDS_LOCKED');
        expect(
          (await world.expenses.get({ id: expense.id }))?.reviewStatus,
        ).toBe('unreviewed');
      });
    });

    it('freezes the money of a reviewed expense until it is reopened', async () => {
      await world.inTenant(async () => {
        const reviewer = randomUUID();
        const expense = await world.expense({ amount: 5000 });
        await expense.review({ reviewerProfileId: reviewer });

        expense.amount = 9000;
        await expectExpenseError(
          expense.save(),
          'EXPENSE_REVIEW_FIELDS_LOCKED',
        );

        expense.amount = 5000;
        expense.description = 'Lumber, kiln dried';
        await expense.save();

        await expense.reopen({ reviewerProfileId: reviewer });
        expense.amount = 9000;
        await expense.save();
        expect((await world.expenses.get({ id: expense.id }))?.amount).toBe(
          9000,
        );
      });
    });

    it('marks a duplicate, which cannot then be reviewed', async () => {
      await world.inTenant(async () => {
        const reviewer = randomUUID();
        const original = await world.expense();
        const copy = await world.expense();

        await expectExpenseError(
          copy.markDuplicate({
            reviewerProfileId: reviewer,
            duplicateOfId: copy.id,
          }),
          'EXPENSE_INVALID',
        );
        await copy.markDuplicate({
          reviewerProfileId: reviewer,
          duplicateOfId: original.id,
        });
        const loaded = await world.expenses.get({ id: copy.id });
        expect(loaded?.reviewStatus).toBe('rejected');
        expect(loaded?.duplicateOfId).toBe(original.id);
        expect(loaded?.isCountable()).toBe(false);

        await copy.reopen({ reviewerProfileId: reviewer });
        expect(copy.duplicateOfId).toBeNull();
        await copy.review({ reviewerProfileId: reviewer });
        expect(copy.reviewStatus).toBe('reviewed');
      });
    });

    it('refuses a duplicate target in another tenant', async () => {
      const other = await createWorld(getDb());
      const foreign = await other.inTenant(() => other.expense());
      await world.inTenant(async () => {
        const expense = await world.expense();
        await expectExpenseError(
          expense.markDuplicate({
            reviewerProfileId: randomUUID(),
            duplicateOfId: foreign.id,
          }),
          'EXPENSE_INVALID',
        );
      });
    });

    it('records reimbursement without touching review state', async () => {
      await world.inTenant(async () => {
        const reviewer = randomUUID();
        const company = await world.expense();
        await expectExpenseError(company.markReimbursed(), 'EXPENSE_INVALID');

        const expense = await world.expense({
          paidBy: 'person',
          paidByProfileId: randomUUID(),
          reimbursable: true,
        });
        await expense.review({ reviewerProfileId: reviewer });
        const reviewedAt = expense.reviewedAt?.toISOString();

        const at = new Date('2026-09-30T00:00:00.000Z');
        await expense.markReimbursed({ at, reference: 'payroll-2026-09' });
        const loaded = await world.expenses.get({ id: expense.id });
        expect(loaded?.isReimbursed()).toBe(true);
        expect(loaded?.reimbursedAt?.toISOString()).toBe(at.toISOString());
        expect(loaded?.reimbursementReference).toBe('payroll-2026-09');
        expect(loaded?.reviewStatus).toBe('reviewed');
        expect(loaded?.reviewedByProfileId).toBe(reviewer);
        expect(loaded?.reviewedAt?.toISOString()).toBe(reviewedAt);
      });
    });
  });

  describe('receipts', () => {
    it('attaches a receipt in the expense tenant without changing review state', async () => {
      await world.inTenant(async () => {
        const reviewer = randomUUID();
        const expense = await world.expense();
        await expense.review({ reviewerProfileId: reviewer });
        const before = await world.expenses.get({ id: expense.id });
        const asset = await world.asset('lumber-yard.pdf');
        const sha = computeContentSha256('receipt-bytes-1');

        const receipt = await world.receipts.attachReceipt({
          expenseId: expense.id,
          assetId: asset.id,
          contentSha256: sha.toUpperCase(),
          byteCount: 15,
          uploadedByProfileId: reviewer,
        });
        expect(receipt.tenantId).toBe(world.tenantId);
        expect(receipt.contentSha256).toBe(sha);
        expect(receipt.filename).toBe('lumber-yard.pdf');
        expect(receipt.mimeType).toBe('application/pdf');

        const after = await world.expenses.get({ id: expense.id });
        expect(after?.reviewStatus).toBe('reviewed');
        expect(after?.reviewedByProfileId).toBe(reviewer);
        expect(String(after?.updated_at)).toBe(String(before?.updated_at));
        expect(
          (await world.receipts.receiptsFor(expense.id)).map((r) => r.id),
        ).toEqual([receipt.id]);
      });
    });

    it('refuses the same file twice on one expense', async () => {
      await world.inTenant(async () => {
        const expense = await world.expense();
        const sha = computeContentSha256('receipt-bytes-2');
        await world.receipts.attachReceipt({
          expenseId: expense.id,
          assetId: (await world.asset()).id,
          contentSha256: sha,
        });

        const second = world.receipts.attachReceipt({
          expenseId: expense.id,
          assetId: (await world.asset('copy.pdf')).id,
          contentSha256: sha,
        });
        await expect(second).rejects.toBeInstanceOf(DuplicateReceiptError);
        await expect(second).rejects.toMatchObject({
          code: 'EXPENSE_RECEIPT_DUPLICATE',
          expenseId: expense.id,
          contentSha256: sha,
        });
        expect(await world.receipts.receiptsFor(expense.id)).toHaveLength(1);
      });
    });

    it('backs the refusal with a unique index on expense and hash', async () => {
      const { db } = world;
      const { expenseId, receiptId } = await world.inTenant(async () => {
        const expense = await world.expense();
        const receipt = await world.receipts.attachReceipt({
          expenseId: expense.id,
          assetId: (await world.asset()).id,
          contentSha256: computeContentSha256('receipt-bytes-3'),
        });
        return { expenseId: expense.id, receiptId: receipt.id };
      });
      // Bypass the model's pre-check: the database itself must refuse a
      // second row for the same (tenant, expense, hash).
      const row = (await db.get('expense_receipts', {
        id: receiptId,
      })) as Record<string, unknown>;
      const copyId = randomUUID();
      await expect(
        db.insert('expense_receipts', { ...row, id: copyId, slug: copyId }),
      ).rejects.toThrow();
      const rows = await world.inTenant(() =>
        world.receipts.receiptsFor(expenseId),
      );
      expect(rows).toHaveLength(1);
    });

    it('allows the same file on two expenses and reports it for review', async () => {
      await world.inTenant(async () => {
        const first = await world.expense({ description: 'Invoice 17' });
        const second = await world.expense({ description: 'Invoice 17 again' });
        const lone = await world.expense();
        const shared = computeContentSha256('shared-receipt');

        for (const expense of [first, second]) {
          await world.receipts.attachReceipt({
            expenseId: expense.id,
            assetId: (await world.asset()).id,
            contentSha256: shared,
          });
        }
        await world.receipts.attachReceipt({
          expenseId: lone.id,
          assetId: (await world.asset()).id,
          contentSha256: computeContentSha256('unique-receipt'),
        });

        const groups = await world.receipts.findDuplicateReceipts();
        expect(groups).toHaveLength(1);
        expect(groups[0].contentSha256).toBe(shared);
        expect(groups[0].expenseIds).toEqual([first.id, second.id].sort());
        expect(groups[0].receipts).toHaveLength(2);

        const forFirst = await world.receipts.findDuplicateReceipts({
          expenseId: first.id,
        });
        expect(forFirst.map((g) => g.expenseIds)).toEqual([
          [first.id, second.id].sort(),
        ]);
        expect(
          await world.receipts.findDuplicateReceipts({ expenseId: lone.id }),
        ).toEqual([]);

        // Flagging is advisory: neither expense's review state moved.
        for (const expense of [first, second]) {
          expect(
            (await world.expenses.get({ id: expense.id }))?.reviewStatus,
          ).toBe('unreviewed');
        }
      });
    });

    it('never reports another tenant’s copy of the same file', async () => {
      const shared = computeContentSha256('cross-tenant-receipt');
      const other = await createWorld(getDb());
      await other.inTenant(async () => {
        const expense = await other.expense();
        await other.receipts.attachReceipt({
          expenseId: expense.id,
          assetId: (await other.asset()).id,
          contentSha256: shared,
        });
      });
      await world.inTenant(async () => {
        const expense = await world.expense();
        await world.receipts.attachReceipt({
          expenseId: expense.id,
          assetId: (await world.asset()).id,
          contentSha256: shared,
        });
        expect(await world.receipts.findDuplicateReceipts()).toEqual([]);
      });
    });

    it('refuses another tenant’s expense or asset, and edits to evidence', async () => {
      const other = await createWorld(getDb());
      const { foreignExpense, foreignAsset } = await other.inTenant(
        async () => ({
          foreignExpense: await other.expense(),
          foreignAsset: await other.asset(),
        }),
      );
      await world.inTenant(async () => {
        const expense = await world.expense();
        await expectExpenseError(
          world.receipts.attachReceipt({
            expenseId: foreignExpense.id,
            assetId: (await world.asset()).id,
            contentSha256: computeContentSha256('a'),
          }),
          'EXPENSE_RECEIPT_INVALID',
        );
        await expectExpenseError(
          world.receipts.attachReceipt({
            expenseId: expense.id,
            assetId: foreignAsset.id,
            contentSha256: computeContentSha256('b'),
          }),
          'EXPENSE_RECEIPT_INVALID',
        );
        await expectExpenseError(
          world.receipts.attachReceipt({
            expenseId: expense.id,
            assetId: (await world.asset()).id,
            contentSha256: 'not-a-digest',
          }),
          'EXPENSE_RECEIPT_INVALID',
        );

        const receipt = await world.receipts.attachReceipt({
          expenseId: expense.id,
          assetId: (await world.asset()).id,
          contentSha256: computeContentSha256('c'),
        });
        receipt.contentSha256 = computeContentSha256('d');
        await expectExpenseError(receipt.save(), 'EXPENSE_RECEIPT_INVALID');
      });
    });

    it('removes the receipt link, not the asset, when the expense is deleted', async () => {
      await world.inTenant(async () => {
        const expense = await world.expense();
        const asset = await world.asset();
        await world.receipts.attachReceipt({
          expenseId: expense.id,
          assetId: asset.id,
          contentSha256: computeContentSha256('deleted-expense'),
        });
        await expense.delete();
        expect(await world.receipts.receiptsFor(expense.id)).toEqual([]);
        expect((await world.assets.get({ id: asset.id }))?.id).toBe(asset.id);
      });
    });
  });

  describe('commitment matching', () => {
    it('leaves 3,600 open on a 4,600 award with 1,000 reviewed', async () => {
      await world.inTenant(async () => {
        const reviewer = randomUUID();
        const award = await world.commitment(460000);
        const actual = await world.expense({
          amount: 100000,
          commitmentId: award.id,
        });
        await actual.review({ reviewerProfileId: reviewer });

        const position = await world.expenses.commitmentPosition(award.id);
        expect(position).toMatchObject({
          commitmentId: award.id,
          currency: 'USD',
          committed: 460000,
          drawn: 100000,
          open: 360000,
          overrun: 0,
          countedExpenseIds: [actual.id],
        });
      });
    });

    it('counts only reviewed, non-duplicate actuals, each once', async () => {
      await world.inTenant(async () => {
        const reviewer = randomUUID();
        const award = await world.commitment(460000);
        const reviewed = await world.expense({
          amount: 100000,
          commitmentId: award.id,
        });
        await reviewed.review({ reviewerProfileId: reviewer });
        await world.expense({ amount: 50000, commitmentId: award.id });
        const rejected = await world.expense({
          amount: 70000,
          commitmentId: award.id,
        });
        await rejected.reject({ reviewerProfileId: reviewer, reason: 'no' });
        const duplicate = await world.expense({
          amount: 100000,
          commitmentId: award.id,
        });
        await duplicate.markDuplicate({
          reviewerProfileId: reviewer,
          duplicateOfId: reviewed.id,
        });

        // Re-saving the reviewed actual must not count it again.
        reviewed.description = 'Framing lumber';
        await reviewed.save();
        await reviewed.save();

        const position = await world.expenses.commitmentPosition(award.id);
        expect(position.drawn).toBe(100000);
        expect(position.open).toBe(360000);
        expect(position.countedExpenseIds).toEqual([reviewed.id]);
        expect(position.excluded).toEqual({
          unreviewed: 1,
          rejected: 1,
          duplicate: 1,
        });
      });
    });

    it('reports an overrun rather than a negative open amount', async () => {
      await world.inTenant(async () => {
        const reviewer = randomUUID();
        const award = await world.commitment(10000);
        const actual = await world.expense({
          amount: 12500,
          commitmentId: award.id,
        });
        await actual.review({ reviewerProfileId: reviewer });
        const position = await world.expenses.commitmentPosition(award.id);
        expect(position.open).toBe(0);
        expect(position.overrun).toBe(2500);
      });
    });

    it('draws down one line of a commitment', async () => {
      await world.inTenant(async () => {
        const reviewer = randomUUID();
        const award = await world.commitment(460000);
        const line = await world.lines.create({
          contractId: award.id,
          description: 'Framing',
          quantity: 1.0,
          unitPrice: 300000,
          amount: 300000,
        });
        await line.save();
        const lineId = saved(line).id;
        const other = await world.commitment(1000);

        const actual = await world.expense({
          amount: 120000,
          commitmentId: award.id,
          commitmentLineId: lineId,
        });
        await actual.review({ reviewerProfileId: reviewer });

        const byLine = await world.expenses.commitmentPosition(award.id, {
          lineId,
        });
        expect(byLine).toMatchObject({
          committed: 300000,
          drawn: 120000,
          open: 180000,
        });
        const whole = await world.expenses.commitmentPosition(award.id);
        expect(whole.open).toBe(340000);

        await expectExpenseError(
          world.expense({ commitmentId: other.id, commitmentLineId: lineId }),
          'EXPENSE_COMMITMENT_MISMATCH',
        );
      });
    });

    it('stores mixed currencies but never sums across them', async () => {
      await world.inTenant(async () => {
        const reviewer = randomUUID();
        const award = await world.commitment(460000, 'USD');
        await expectExpenseError(
          world.expense({
            amount: 50000,
            currency: 'CAD',
            commitmentId: award.id,
          }),
          'EXPENSE_COMMITMENT_MISMATCH',
        );

        const usd = await world.expense({ amount: 100000, currency: 'USD' });
        const cad = await world.expense({ amount: 40000, currency: 'CAD' });
        const eur = await world.expense({ amount: 7000, currency: 'EUR' });
        for (const expense of [usd, cad, eur]) {
          await expense.review({ reviewerProfileId: reviewer });
        }
        await world.expense({ amount: 999, currency: 'USD' });

        expect(await world.expenses.totalsByCurrency()).toEqual({
          CAD: { amount: 40000, count: 1 },
          EUR: { amount: 7000, count: 1 },
          USD: { amount: 100000, count: 1 },
        });
        expect(
          await world.expenses.totalsByCurrency({
            reviewStatuses: ['reviewed', 'unreviewed'],
            where: { currency: 'USD' },
          }),
        ).toEqual({ USD: { amount: 100999, count: 2 } });
      });
    });

    it('shows, never draws, actuals left in another currency by a later commitment change', async () => {
      await world.inTenant(async () => {
        const reviewer = randomUUID();
        const award = await world.commitment(460000, 'USD');
        const actual = await world.expense({
          amount: 100000,
          commitmentId: award.id,
          paidBy: 'person',
          paidByProfileId: randomUUID(),
          reimbursable: true,
        });
        await actual.review({ reviewerProfileId: reviewer });

        const contract = await world.contracts.get({ id: award.id });
        if (!contract) throw new Error('commitment not loaded');
        contract.currency = 'CAD';
        await contract.save();

        // The match was valid when made; later saves still work.
        await actual.markReimbursed({ reference: 'payroll-1' });

        const position = await world.expenses.commitmentPosition(award.id);
        expect(position).toMatchObject({
          currency: 'CAD',
          drawn: 0,
          open: 460000,
          otherCurrencies: { USD: { amount: 100000, count: 1 } },
        });
      });
    });

    it('refuses a commitment from another tenant', async () => {
      const other = await createWorld(getDb());
      const foreign = await other.inTenant(() => other.commitment(1000));
      await world.inTenant(async () => {
        await expectExpenseError(
          world.expense({ commitmentId: foreign.id }),
          'EXPENSE_COMMITMENT_MISMATCH',
        );
        await expectExpenseError(
          world.expenses.commitmentPosition(foreign.id),
          'EXPENSE_COMMITMENT_MISMATCH',
        );
      });
    });
  });

  describe('cost objects', () => {
    it('lists and totals the expenses of one cost object', async () => {
      await world.inTenant(async () => {
        const reviewer = randomUUID();
        const later = await world.expense({
          costObjectId: 'job-7',
          incurredOn: '2026-09-20',
          amount: 300,
        });
        const earlier = await world.expense({
          costObjectId: 'job-7',
          incurredOn: '2026-09-01',
          amount: 200,
        });
        await world.expense({ costObjectId: 'job-8', amount: 999 });
        await later.review({ reviewerProfileId: reviewer });
        await earlier.review({ reviewerProfileId: reviewer });

        const rows = await world.expenses.forCostObject(PROJECT, 'job-7');
        expect(rows.map((row) => row.id)).toEqual([earlier.id, later.id]);
        expect(
          await world.expenses.totalsByCurrency({
            where: { costObjectType: PROJECT, costObjectId: 'job-7' },
          }),
        ).toEqual({ USD: { amount: 500, count: 2 } });
      });
    });
  });

  describe('identity and evidence integrity', () => {
    it('refuses a new expense that names a reviewed expense by slug', async () => {
      await world.inTenant(async () => {
        const reviewer = randomUUID();
        const reviewed = await world.expense({ amount: 5000 });
        await reviewed.review({ reviewerProfileId: reviewer });

        const forged = world.expense({
          slug: reviewed.id,
          amount: 9000,
        } as ExpenseOptions);
        await expectExpenseError(forged, 'EXPENSE_IDENTITY_CONFLICT');

        const stored = await world.expenses.get({ id: reviewed.id });
        expect(stored?.reviewStatus).toBe('reviewed');
        expect(stored?.reviewedByProfileId).toBe(reviewer);
        expect(stored?.amount).toBe(5000);
      });
    });

    it('refuses an existing expense whose slug points at another row', async () => {
      await world.inTenant(async () => {
        const reviewer = randomUUID();
        const reviewed = await world.expense({ amount: 5000 });
        await reviewed.review({ reviewerProfileId: reviewer });
        const other = await world.expense({ amount: 100 });

        // collection.create() saves.
        const retarget = world.expenses.create({
          id: other.id,
          slug: reviewed.id,
          costObjectType: PROJECT,
          costObjectId: 'project-1',
          amount: 9000,
          currency: 'USD',
          incurredOn: '2026-09-15',
        } as ExpenseOptions);
        await expectExpenseError(retarget, 'EXPENSE_IDENTITY_CONFLICT');
        expect((await world.expenses.get({ id: other.id }))?.amount).toBe(100);

        const stored = await world.expenses.get({ id: reviewed.id });
        expect(stored?.reviewStatus).toBe('reviewed');
        expect(stored?.amount).toBe(5000);
      });
    });

    it('refuses a new receipt that names an existing receipt by slug', async () => {
      await world.inTenant(async () => {
        const expense = await world.expense();
        const original = computeContentSha256('original-evidence');
        const receipt = await world.receipts.attachReceipt({
          expenseId: expense.id,
          assetId: (await world.asset()).id,
          contentSha256: original,
        });

        // collection.create() saves.
        const forgedAsset = await world.asset('forged.pdf');
        const forged = world.receipts.create({
          slug: receipt.id,
          expenseId: expense.id,
          assetId: forgedAsset.id,
          contentSha256: computeContentSha256('forged-evidence'),
        } as never);
        await expectExpenseError(forged, 'EXPENSE_IDENTITY_CONFLICT');

        const stored = await world.receipts.get({ id: String(receipt.id) });
        expect(stored?.contentSha256).toBe(original);
        expect(stored?.assetId).toBe(receipt.assetId);
      });
    });

    it('refuses a vendor from another tenant, on create and on change', async () => {
      const other = await createWorld(getDb());
      const foreign = await other.inTenant(() => other.vendor());
      await world.inTenant(async () => {
        await expectExpenseError(
          world.expense({ vendorId: foreign.id }),
          'EXPENSE_VENDOR_MISMATCH',
        );

        const own = await world.vendor();
        const expense = await world.expense({ vendorId: own.id });
        expect(expense.vendorId).toBe(own.id);

        expense.vendorId = foreign.id;
        await expectExpenseError(expense.save(), 'EXPENSE_VENDOR_MISMATCH');
        expect((await world.expenses.get({ id: expense.id }))?.vendorId).toBe(
          own.id,
        );
      });
    });

    it('enforces one copy of a file per expense in the database, even without a tenant', async () => {
      // No tenant context: optional tenancy writes a global (NULL-tenant) row.
      const expense = await world.expense();
      expect(expense.tenantId).toBeNull();
      const receipt = await world.receipts.attachReceipt({
        expenseId: expense.id,
        assetId: (await world.asset()).id,
        contentSha256: computeContentSha256(`global-${randomUUID()}`),
      });
      const row = (await world.db.get('expense_receipts', {
        id: receipt.id,
      })) as Record<string, unknown>;
      const copyId = randomUUID();
      await expect(
        world.db.insert('expense_receipts', {
          ...row,
          id: copyId,
          slug: copyId,
        }),
      ).rejects.toThrow();
      expect(await world.receipts.receiptsFor(expense.id)).toHaveLength(1);
    });

    it('refuses the inherited junction writers instead of losing evidence', async () => {
      await world.inTenant(async () => {
        const expense = await world.expense();
        const asset = await world.asset();
        await world.receipts.attachReceipt({
          expenseId: expense.id,
          assetId: asset.id,
          contentSha256: computeContentSha256('kept-evidence'),
        });

        await expect(
          world.receipts.setLinks(expense.id, [asset.id]),
        ).rejects.toMatchObject({
          code: 'EXPENSE_RECEIPT_INVALID',
          message: expect.stringContaining('attachReceipt'),
        });
        await expect(
          world.receipts.attach(expense.id, asset.id, {
            contentSha256: computeContentSha256('via-attach'),
          }),
        ).rejects.toMatchObject({
          code: 'EXPENSE_RECEIPT_INVALID',
          message: expect.stringContaining('attachReceipt'),
        });
        const kept = await world.receipts.receiptsFor(expense.id);
        expect(kept.map((r) => r.contentSha256)).toEqual([
          computeContentSha256('kept-evidence'),
        ]);

        // The batch junction path only runs for models with the base save
        // lifecycle; ExpenseReceipt's own save() keeps every write on it.
        expect(
          SmrtObject.hasBaseJunctionLifecycle(ExpenseReceipt.prototype),
        ).toBe(false);

        // detach is the explicit way to remove a link; the asset survives.
        await world.receipts.detach(expense.id, asset.id);
        expect(await world.receipts.receiptsFor(expense.id)).toEqual([]);
        expect((await world.assets.get({ id: asset.id }))?.id).toBe(asset.id);
      });
    });
  });

  describe('review round 2 (PR #3339)', () => {
    it('reports a duplicate the pre-insert read cannot see as DuplicateReceiptError', async () => {
      const { expenseId, sha } = await hideReceiptFromTenantReads(world);
      await world.inTenant(async () => {
        await expect(
          world.receipts.attachReceipt({
            expenseId,
            assetId: (await world.asset()).id,
            contentSha256: sha,
          }),
        ).rejects.toBeInstanceOf(DuplicateReceiptError);
      });
    });

    it('freezes recordedAt on a reviewed expense until it is reopened', async () => {
      await world.inTenant(async () => {
        const reviewer = randomUUID();
        const expense = await world.expense();
        await expense.review({ reviewerProfileId: reviewer });
        const recordedAt = expense.recordedAt?.toISOString();

        // An unchanged instant (as hydrated from the database) still saves.
        const loaded = await world.expenses.get({ id: expense.id });
        if (!loaded) throw new Error('expense not loaded');
        loaded.description = 'Lumber, reviewed';
        await loaded.save();

        loaded.recordedAt = new Date('2020-01-01T00:00:00.000Z');
        await expectExpenseError(loaded.save(), 'EXPENSE_REVIEW_FIELDS_LOCKED');
        expect(
          (
            await world.expenses.get({ id: expense.id })
          )?.recordedAt?.toISOString(),
        ).toBe(recordedAt);

        // The refused instance still holds the change; reopen a fresh one.
        const fresh = await world.expenses.get({ id: expense.id });
        if (!fresh) throw new Error('expense not loaded');
        await fresh.reopen({ reviewerProfileId: reviewer });
        fresh.recordedAt = new Date('2020-01-01T00:00:00.000Z');
        await fresh.save();
        expect(
          (
            await world.expenses.get({ id: expense.id })
          )?.recordedAt?.toISOString(),
        ).toBe('2020-01-01T00:00:00.000Z');
      });
    });

    it('applies the limit to duplicate groups, not to the expense’s own receipts', async () => {
      await world.inTenant(async () => {
        const expense = await world.expense();
        // Older unique receipts first, the shared one last.
        for (let i = 0; i < 4; i++) {
          await world.receipts.attachReceipt({
            expenseId: expense.id,
            assetId: (await world.asset()).id,
            contentSha256: computeContentSha256(`unique-${i}-${randomUUID()}`),
          });
        }
        const shared = computeContentSha256(`shared-${randomUUID()}`);
        const other = await world.expense();
        for (const owner of [expense, other]) {
          await world.receipts.attachReceipt({
            expenseId: owner.id,
            assetId: (await world.asset()).id,
            contentSha256: shared,
          });
        }

        const groups = await world.receipts.findDuplicateReceipts({
          expenseId: expense.id,
          limit: 1,
        });
        expect(groups.map((group) => group.contentSha256)).toEqual([shared]);
        expect(groups[0]?.expenseIds).toEqual([expense.id, other.id].sort());
      });
    });

    it('keeps a receipt in its expense tenant on every later save', async () => {
      const receipt = await world.inTenant(async () => {
        const expense = await world.expense();
        return world.receipts.attachReceipt({
          expenseId: expense.id,
          assetId: (await world.asset()).id,
          contentSha256: computeContentSha256(`tenant-${randomUUID()}`),
        });
      });

      // A trusted save without tenant context (optional tenancy) must not
      // move the receipt away from the tenant its expense lives in.
      for (const moved of [randomUUID(), null]) {
        const loaded = await world.receipts.get({ id: String(receipt.id) });
        if (!loaded) throw new Error('receipt not loaded');
        loaded.tenantId = moved;
        await expectExpenseError(loaded.save(), 'EXPENSE_RECEIPT_INVALID');
      }
      const stored = await world.receipts.get({ id: String(receipt.id) });
      expect(stored?.tenantId).toBe(world.tenantId);
    });

    it('never persists a duplicate marker a transition did not set', async () => {
      const other = await createWorld(getDb());
      const foreign = await other.inTenant(() => other.expense());
      await world.inTenant(async () => {
        const reviewer = randomUUID();

        // Injected before review(): a reviewed expense never carries one.
        const reviewed = await world.expense();
        reviewed.duplicateOfId = foreign.id;
        await reviewed.review({ reviewerProfileId: reviewer });
        const storedReviewed = await world.expenses.get({ id: reviewed.id });
        expect(storedReviewed?.reviewStatus).toBe('reviewed');
        expect(storedReviewed?.duplicateOfId).toBeNull();

        // Injected before reject(): only markDuplicate() sets the marker,
        // after checking the target is in the same tenant.
        const rejected = await world.expense();
        rejected.duplicateOfId = foreign.id;
        await rejected.reject({ reviewerProfileId: reviewer, reason: 'no' });
        const storedRejected = await world.expenses.get({ id: rejected.id });
        expect(storedRejected?.reviewStatus).toBe('rejected');
        expect(storedRejected?.duplicateOfId).toBeNull();
      });
    });
  });

  describe('review round 3 (PR #3339)', () => {
    it('refuses a fresh instance that names an existing expense id', async () => {
      await world.inTenant(async () => {
        const existing = await world.expense({ amount: 5000 });
        // collection.create() saves; same id and same slug, new money.
        const overwrite = world.expenses.create({
          id: existing.id,
          slug: existing.slug,
          costObjectType: PROJECT,
          costObjectId: 'project-1',
          amount: 9000,
          currency: 'USD',
          incurredOn: '2026-09-15',
        } as ExpenseOptions);
        await expectExpenseError(overwrite, 'EXPENSE_IDENTITY_CONFLICT');
        expect((await world.expenses.get({ id: existing.id }))?.amount).toBe(
          5000,
        );
      });
    });

    it('never lets a fresh instance overwrite a review that lands mid-save', async () => {
      await world.inTenant(async () => {
        const reviewer = randomUUID();
        const existing = await world.expense({ amount: 5000 });
        // A fresh, never-loaded instance carrying the existing id.
        const fresh = new Expense({
          db: world.db,
          _skipLoad: true,
          id: existing.id,
          slug: existing.slug,
          costObjectType: PROJECT,
          costObjectId: 'project-1',
          amount: 9000,
          currency: 'USD',
          incurredOn: '2026-09-15',
        } as ExpenseOptions);
        await fresh.initialize();
        expect(fresh.isPersisted).toBe(false);

        // The review lands after the fresh save's guards have read the row
        // and before its write: a beforeSave interceptor runs exactly there.
        let fired = false;
        GlobalInterceptors.register({
          name: 'expenses-review-race-3339',
          async beforeSave(instance) {
            if (instance !== fresh || fired) return;
            fired = true;
            const loaded = await world.expenses.get({ id: existing.id });
            await loaded?.review({ reviewerProfileId: reviewer });
          },
        });
        try {
          await expect(fresh.save()).rejects.toBeTruthy();
        } finally {
          GlobalInterceptors.unregister('expenses-review-race-3339');
        }

        const stored = await world.expenses.get({ id: existing.id });
        expect(stored?.amount).toBe(5000);
        if (fired) {
          expect(stored?.reviewStatus).toBe('reviewed');
          expect(stored?.reviewedByProfileId).toBe(reviewer);
        }
      });
    });
  });
}
