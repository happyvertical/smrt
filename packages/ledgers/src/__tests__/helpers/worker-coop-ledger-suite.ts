import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { withSuperAdminBypass, withTenant } from '@happyvertical/smrt-tenancy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountCollection } from '../../collections/Accounts';
import { JournalEntryCollection } from '../../collections/JournalEntries';
import { JournalCollection } from '../../collections/Journals';
import { LedgerCollection } from '../../collections/Ledgers';
import { Journal } from '../../models/Journal';
import {
  type LedgerPostingInput,
  postReceivable,
  postSettlement,
} from '../../postings';

export function defineWorkerCoopLedgerSuite(
  type: 'sqlite' | 'postgres',
  createDb: () => Promise<DatabaseInterface>,
) {
  describe(`worker co-op exact ledger (${type})`, () => {
    let db: DatabaseInterface;
    let base: LedgerPostingInput;
    beforeEach(async () => {
      db = await createDb();
      const tenantId = crypto.randomUUID();
      await withTenant({ tenantId }, async () => {
        const ledger = await (await LedgerCollection.create({ db })).create({
          tenantId,
          name: 'Worker co-op',
          currency: 'CAD',
          balanceMode: 'exact-integer',
        });
        const accounts = await AccountCollection.create({ db });
        const ar = await accounts.create({
          tenantId,
          ledgerId: ledger.id!,
          number: '1100',
          name: 'Client receivable',
          type: 'asset',
        });
        const revenue = await accounts.create({
          tenantId,
          ledgerId: ledger.id!,
          number: '4000',
          name: 'Project revenue',
          type: 'revenue',
        });
        base = {
          db,
          tenantId,
          ledgerId: ledger.id!,
          idempotencyKey: 'invoice-7',
          sourceModule: 'worker-coop',
          sourceRef: 'invoice-7',
          description: 'Project seven',
          date: new Date('2026-10-01'),
          currency: 'CAD',
          amountMinor: 10000,
          counterparty: { kind: 'client', id: 'client-7' },
          debitAccountId: ar.id!,
          creditAccountId: revenue.id!,
          dueDate: new Date('2026-10-10'),
        };
      });
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await (db as { close?: () => Promise<void> }).close?.();
    });
    it('serializes concurrent same-key replay and denies concurrent content changes', async () => {
      const results = await Promise.all([
        postReceivable(base),
        postReceivable(base),
      ]);
      expect(results[0].id).toBe(results[1].id);
      const changed = await Promise.allSettled([
        postReceivable({ ...base, idempotencyKey: 'race' }),
        postReceivable({ ...base, idempotencyKey: 'race', amountMinor: 9999 }),
      ]);
      expect(changed.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(changed.filter((r) => r.status === 'rejected')).toHaveLength(1);
      await expect(
        postReceivable({ ...base, date: new Date('2026-10-02') }),
      ).rejects.toThrow(/different content/);
      expect((await db.query('SELECT id FROM journals')).rows).toHaveLength(2);
      expect(
        (await db.query('SELECT id FROM journal_entries')).rows,
      ).toHaveLength(4);
    });
    it('rolls back journals, lines and receipts after posting failure, then retries', async () => {
      const original = Journal.prototype.post;
      vi.spyOn(Journal.prototype, 'post').mockImplementationOnce(
        async function (this: Journal) {
          await original.call(this);
          throw new Error('crash before receipt');
        },
      );
      await expect(postReceivable(base)).rejects.toThrow(
        'crash before receipt',
      );
      expect((await db.query('SELECT id FROM journals')).rows).toHaveLength(0);
      expect(
        (await db.query('SELECT id FROM journal_entries')).rows,
      ).toHaveLength(0);
      expect(
        (await db.query('SELECT claim_key FROM _smrt_run_once_claims')).rows,
      ).toHaveLength(0);
      const journal = await postReceivable(base);
      expect((await postReceivable(base)).id).toBe(journal.id);
    });
    it('denies wrong currency, foreign accounts, context and noninteger amounts atomically', async () => {
      for (const amountMinor of [
        1.5,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
        0,
      ])
        await expect(
          postReceivable({ ...base, amountMinor }),
        ).rejects.toThrow();
      await expect(
        postReceivable({ ...base, currency: 'USD' }),
      ).rejects.toThrow(/currency/);
      await expect(
        withTenant({ tenantId: 'foreign-context' }, () => postReceivable(base)),
      ).rejects.toThrow(/context/);
      await expect(
        postReceivable({ ...base, tenantId: crypto.randomUUID() }),
      ).rejects.toThrow();
      await expect(
        withTenant({ tenantId: 'foreign-admin' }, () =>
          withSuperAdminBypass(() => postReceivable(base)),
        ),
      ).rejects.toThrow(/context/);
      const accounts = await AccountCollection.create({ db });
      const foreign = await accounts.create({
        tenantId: crypto.randomUUID(),
        ledgerId: base.ledgerId,
        name: 'Foreign',
        number: '9000',
        type: 'asset',
      });
      await expect(
        postReceivable({ ...base, debitAccountId: foreign.id! }),
      ).rejects.toThrow();
      expect((await db.query('SELECT id FROM journals')).rows).toHaveLength(0);
    });
    it('keeps compensating partial/full settlements immutable and ages at historical cutoffs', async () => {
      const original = await postReceivable(base);
      const settlement = {
        ...base,
        idempotencyKey: 'payout-1',
        sourceRef: 'payout-1',
        settlesSourceRef: base.sourceRef,
        dueDate: undefined,
        amountMinor: 4000,
        date: new Date('2026-10-20'),
        debitAccountId: base.creditAccountId,
        creditAccountId: base.debitAccountId,
      };
      await postSettlement(settlement);
      const entries = await JournalEntryCollection.create({ db });
      const options = {
        tenantId: base.tenantId,
        accountIds: [base.debitAccountId],
        currency: 'CAD',
        from: new Date('2026-01-01'),
        to: new Date('2026-12-01'),
      };
      expect(
        (
          await entries.getCounterpartyAging(options, new Date('2026-10-15'))
        )[0],
      ).toMatchObject({ balance: 10000, days1To30: 10000 });
      expect(
        (
          await entries.getCounterpartyAging(options, new Date('2026-10-25'))
        )[0],
      ).toMatchObject({ balance: 6000, days1To30: 6000 });
      expect((await entries.getCounterpartyBalances(options))[0].balance).toBe(
        6000,
      );
      original.description = 'tamper';
      await expect(original.save()).rejects.toThrow();
      await expect(original.void('refund')).rejects.toThrow();
      await expect(original.delete()).rejects.toThrow();
      const line = (await entries.findByJournal(original.id!))[0];
      line.debit = 9000;
      await expect(line.save()).rejects.toThrow();
      await expect(line.delete()).rejects.toThrow();
      await postSettlement({
        ...settlement,
        idempotencyKey: 'payout-2',
        sourceRef: 'payout-2',
        amountMinor: 6000,
        date: new Date('2026-11-01'),
      });
      expect(
        await entries.getCounterpartyAging(options, new Date('2026-12-01')),
      ).toEqual([]);
      expect(
        (
          await (
            await JournalCollection.create({ db })
          ).get({ id: original.id! })
        )?.status,
      ).toBe('posted');
    });
    it('freezes policy and account ownership and rejects fractional manual postings', async () => {
      const ledgers = await LedgerCollection.create({ db });
      const ledger = await ledgers.get({ id: base.ledgerId });
      expect(ledger).toBeTruthy();
      ledger!.currency = 'USD';
      await expect(ledger!.save()).rejects.toThrow();
      await expect(ledger!.delete()).rejects.toThrow();
      const accounts = await AccountCollection.create({ db });
      const account = await accounts.get({ id: base.debitAccountId });
      account!.ledgerId = null;
      await expect(account!.save()).rejects.toThrow();
      await expect(account!.delete()).rejects.toThrow();
      const journals = await JournalCollection.create({ db });
      const journal = await journals.createWithEntries({
        tenantId: base.tenantId,
        ledgerId: base.ledgerId,
        description: 'Fraction rejected',
        entries: [
          { accountId: base.debitAccountId, debit: 1.5, currency: 'CAD' },
          { accountId: base.creditAccountId, credit: 1.5, currency: 'CAD' },
        ],
      });
      await expect(journal.post()).rejects.toThrow(/balanced/);
      journal.ledgerId = null;
      await expect(journal.post()).rejects.toThrow();
      journal.status = 'posted';
      await expect(journal.save()).rejects.toThrow();
    });
    it('serializes manual draft edits against posting with a parent revision claim', async () => {
      const journals = await JournalCollection.create({ db });
      const draft = await journals.createWithEntries({
        tenantId: base.tenantId,
        ledgerId: base.ledgerId,
        description: 'Manual draft',
        entries: [
          { accountId: base.debitAccountId, debit: 1000, currency: 'CAD' },
          { accountId: base.creditAccountId, credit: 1000, currency: 'CAD' },
        ],
      });
      const entries = await JournalEntryCollection.create({ db });
      const line = (await entries.findByJournal(draft.id!)).find(
        (entry) => entry.debit > 0,
      )!;
      line.debit = 500;
      const results = await Promise.allSettled([draft.post(), line.save()]);
      expect(
        results.filter((result) => result.status === 'rejected').length,
      ).toBeGreaterThan(0);
      const stored = await journals.get({ id: draft.id! });
      if (stored!.isPosted()) expect(await stored!.isBalanced()).toBe(true);
      else expect(stored!.status).toBe('draft');
    });
    it('applies out-of-order settlements and supports credit-normal AP aging', async () => {
      await postSettlement({
        ...base,
        idempotencyKey: 'early',
        sourceRef: 'early',
        settlesSourceRef: base.sourceRef,
        dueDate: undefined,
        date: new Date('2026-09-30'),
        amountMinor: 3000,
        debitAccountId: base.creditAccountId,
        creditAccountId: base.debitAccountId,
      });
      await postReceivable(base);
      const entries = await JournalEntryCollection.create({ db });
      const options = {
        tenantId: base.tenantId,
        accountIds: [base.creditAccountId],
        currency: 'CAD',
        from: new Date('2026-01-01'),
        to: new Date('2026-12-01'),
        normalBalance: 'credit' as const,
      };
      expect(
        (await entries.getCounterpartyAging(options, options.to))[0],
      ).toMatchObject({ balance: 7000, days31To60: 7000 });
    });
  });
}
