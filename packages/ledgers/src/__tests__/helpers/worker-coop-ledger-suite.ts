import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  disableTenancy,
  enableTenancy,
  withSuperAdminBypass,
  withTenant,
} from '@happyvertical/smrt-tenancy';
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
      disableTenancy();
      vi.restoreAllMocks();
      await (db as { close?: () => Promise<void> }).close?.();
    });
    it('fixes journal ledger scope at creation, including legacy drafts', async () => {
      const journals = await JournalCollection.create({ db });
      const legacy = await journals.create({
        tenantId: base.tenantId,
        description: 'Legacy draft',
      });
      legacy.ledgerId = base.ledgerId;
      await expect(legacy.save()).rejects.toThrow();
      expect(
        (await journals.get(legacy.id!, { cache: false }))!.ledgerId,
      ).toBeNull();
      const scoped = await journals.create({
        tenantId: base.tenantId,
        ledgerId: base.ledgerId,
        description: 'Scoped draft',
      });
      scoped.description = 'Allowed draft edit';
      await scoped.save();
      for (const ledgerId of [
        null,
        (
          await (
            await LedgerCollection.create({ db })
          ).create({
            tenantId: base.tenantId,
            name: 'Other scope',
            currency: 'CAD',
            balanceMode: 'exact-integer',
          })
        ).id!,
      ]) {
        scoped.ledgerId = ledgerId;
        await expect(scoped.save()).rejects.toThrow();
        expect(
          (await journals.get(scoped.id!, { cache: false }))!.ledgerId,
        ).toBe(base.ledgerId);
      }
    });
    it('preserves generated slug disambiguation and refuses getOrUpsert adoption', async () => {
      const ledgers = await LedgerCollection.create({ db });
      await expect(
        ledgers.getOrUpsert({
          tenantId: base.tenantId,
          name: 'Worker co-op',
          currency: 'USD',
          balanceMode: 'tolerant',
        }),
      ).rejects.toThrow();
      const copies = await Promise.all(
        [1, 2].map(() =>
          ledgers.create({
            tenantId: base.tenantId,
            name: 'Same generated name',
            currency: 'CAD',
            balanceMode: 'exact-integer',
          }),
        ),
      );
      expect(copies[0].id).not.toBe(copies[1].id);
      expect(copies[0].slug).not.toBe(copies[1].slug);
      await expect(
        ledgers.create({
          tenantId: base.tenantId,
          name: 'Same generated name',
          currency: 'CAD',
          balanceMode: 'exact-integer',
          _insertOnly: true,
        }),
      ).rejects.toThrow();
      expect(
        (await ledgers.get(base.ledgerId, { cache: false }))!.currency,
      ).toBe('CAD');
    });
    it('allows only one concurrent explicit accounting identity insertion', async () => {
      const ledgers = await LedgerCollection.create({ db });
      const results = await Promise.allSettled(
        ['CAD', 'USD'].map((currency) =>
          ledgers.create({
            tenantId: base.tenantId,
            slug: 'one-concurrent-identity',
            name: currency,
            currency,
            balanceMode: 'exact-integer',
          }),
        ),
      );
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1);
      const winner = results.find((result) => result.status === 'fulfilled');
      if (!winner || winner.status !== 'fulfilled')
        throw new Error('Expected one insert');
      const stored = (await ledgers.get(winner.value.id!, { cache: false }))!;
      expect(stored.currency).toBe(winner.value.currency);
      expect(
        await ledgers.list({ where: { slug: 'one-concurrent-identity' } }),
      ).toHaveLength(1);
    });
    it('rejects natural-key replacement of immutable ledger policy', async () => {
      const ledgers = await LedgerCollection.create({ db });
      const original = (await ledgers.get(base.ledgerId))!;
      await postReceivable(base);
      await expect(
        ledgers.create({
          tenantId: base.tenantId,
          slug: original.slug,
          context: original.context,
          name: 'Replacement',
          currency: 'USD',
          balanceMode: 'tolerant',
        }),
      ).rejects.toThrow();
      const stored = (await (
        await LedgerCollection.create({ db })
      ).get(base.ledgerId, { cache: false }))!;
      expect(stored.currency).toBe('CAD');
      expect(stored.balanceMode).toBe('exact-integer');
    });
    it('rejects natural-key replacement of scoped and legacy accounts', async () => {
      const accounts = await AccountCollection.create({ db });
      const original = (await accounts.get(base.debitAccountId))!;
      await postReceivable(base);
      await expect(
        accounts.create({
          tenantId: base.tenantId,
          slug: original.slug,
          context: original.context,
          number: '9999',
          name: 'Replacement',
          type: 'revenue',
          ledgerId: null,
        }),
      ).rejects.toThrow();
      const stored = (await accounts.get(base.debitAccountId, {
        cache: false,
      }))!;
      expect(stored.ledgerId).toBe(base.ledgerId);
      expect(stored.type).toBe('asset');
      const legacy = await accounts.create({
        tenantId: base.tenantId,
        name: 'Legacy collision',
        number: '2000',
        type: 'asset',
      });
      await expect(
        accounts.create({
          tenantId: base.tenantId,
          slug: legacy.slug,
          context: legacy.context,
          number: '2001',
          name: 'Promotion',
          type: 'asset',
          ledgerId: base.ledgerId,
        }),
      ).rejects.toThrow();
      expect(
        (await accounts.get(legacy.id!, { cache: false }))!.ledgerId,
      ).toBeNull();
      // Updates remain explicit through the persisted identity.
      legacy.name = 'Renamed legacy';
      await legacy.save();
      expect((await accounts.get(legacy.id!, { cache: false }))!.name).toBe(
        'Renamed legacy',
      );
    });
    it('rejects natural-key replacement of posted journals', async () => {
      const posted = await postReceivable(base);
      const journals = await JournalCollection.create({ db });
      await expect(
        journals.create({
          tenantId: base.tenantId,
          slug: posted.slug,
          context: posted.context,
          description: 'Replacement draft',
          ledgerId: null,
          status: 'draft',
        }),
      ).rejects.toThrow();
      const stored = (await journals.get(posted.id!, { cache: false }))!;
      expect(stored.status).toBe('posted');
      expect(stored.ledgerId).toBe(base.ledgerId);
      await expect(stored.delete()).rejects.toThrow(/immutable/);
    });
    it('rejects natural-key replacement of posted journal lines', async () => {
      const posted = await postReceivable(base);
      const original = (await posted.getEntries())[0];
      const draft = await (await JournalCollection.create({ db })).create({
        tenantId: base.tenantId,
        ledgerId: base.ledgerId,
        description: 'Collision draft',
      });
      const entries = await JournalEntryCollection.create({ db });
      await expect(
        entries.create({
          tenantId: base.tenantId,
          slug: original.slug,
          context: original.context,
          journalId: draft.id!,
          accountId: original.accountId,
          debit: 1,
          credit: 0,
          currency: 'CAD',
        }),
      ).rejects.toThrow();
      const stored = (await entries.get(original.id!, { cache: false }))!;
      expect(stored.journalId).toBe(posted.id);
      expect(stored.debit).toBe(original.debit);
      expect(stored.credit).toBe(original.credit);
      expect(await posted.isBalanced()).toBe(true);
      expect(await draft.getEntries()).toHaveLength(0);
    });
    it('permits shared unassigned global accounts for legacy tenant journals only', async () => {
      const accounts = await AccountCollection.create({ db });
      const globalDebit = await accounts.create({
        name: 'Global asset',
        number: 'G1',
        type: 'asset',
      });
      const globalCredit = await accounts.create({
        name: 'Global revenue',
        number: 'G2',
        type: 'revenue',
      });
      const foreign = await accounts.create({
        tenantId: crypto.randomUUID(),
        name: 'Foreign legacy',
        number: 'F1',
        type: 'asset',
      });
      enableTenancy();
      await withTenant({ tenantId: base.tenantId }, async () => {
        const journal = await (await JournalCollection.create({ db })).create({
          description: 'Tenant legacy',
        });
        const entries = await JournalEntryCollection.create({ db });
        await entries.create({
          journalId: journal.id!,
          accountId: globalDebit.id!,
          debit: 1.25,
        });
        await entries.create({
          journalId: journal.id!,
          accountId: globalCredit.id!,
          credit: 1.25,
        });
        await journal.post();
        expect(await journal.isBalanced()).toBe(true);
        const debitLine = (await journal.getEntries()).find(
          (line) => line.debit > 0,
        )!;
        debitLine.accountId = globalCredit.id!;
        await debitLine.save();
        expect((await debitLine.getAccount())!.id).toBe(globalCredit.id);
        const draft = await (await JournalCollection.create({ db })).create({
          description: 'Foreign denial',
        });
        await expect(
          entries.create({
            journalId: draft.id!,
            accountId: foreign.id!,
            debit: 1,
          }),
        ).rejects.toThrow();
        const scoped = await (await JournalCollection.create({ db })).create({
          ledgerId: base.ledgerId,
          description: 'Scoped denial',
        });
        await expect(
          entries.create({
            journalId: scoped.id!,
            accountId: globalDebit.id!,
            debit: 1,
            currency: 'CAD',
          }),
        ).rejects.toThrow();
        expect(await draft.getEntries()).toHaveLength(0);
        expect(await scoped.getEntries()).toHaveLength(0);
      });
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
    it('snapshots request data before asynchronous posting', async () => {
      const input = { ...base, counterparty: { ...base.counterparty } };
      const pending = postReceivable(input);
      input.amountMinor = 20000;
      input.counterparty.id = 'changed-after-submission';
      const journal = await pending;
      expect(await journal.getTotalDebits()).toBe(10000);
      expect((await journal.getEntries())[0].counterpartyId).toBe(
        base.counterparty.id,
      );
      expect((await postReceivable(base)).id).toBe(journal.id);
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
    it('replays an identical retry after the run-once claim is pruned (#4067)', async () => {
      const original = await postReceivable(base);
      await db.query('DELETE FROM _smrt_run_once_claims');
      const replay = await postReceivable(base);
      expect(replay.id).toBe(original.id);
      expect(replay.isPosted()).toBe(true);
      expect((await db.query('SELECT id FROM journals')).rows).toHaveLength(1);
      expect(
        (await db.query('SELECT id FROM journal_entries')).rows,
      ).toHaveLength(2);
      expect(await replay.getTotalDebits()).toBe(10000);
      expect(await replay.getTotalCredits()).toBe(10000);
    });
    it('refuses a changed retry after the run-once claim is pruned (#4067)', async () => {
      await postReceivable(base);
      await db.query('DELETE FROM _smrt_run_once_claims');
      await expect(
        postReceivable({ ...base, amountMinor: 9999 }),
      ).rejects.toThrow(/different content/);
      expect((await db.query('SELECT id FROM journals')).rows).toHaveLength(1);
      expect(
        (await db.query('SELECT id FROM journal_entries')).rows,
      ).toHaveLength(2);
      expect(
        (await db.query('SELECT claim_key FROM _smrt_run_once_claims')).rows,
      ).toHaveLength(0);
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
        postReceivable({ ...base, idempotencyKey: ' padded ' }),
      ).rejects.toThrow();
      await expect(
        postReceivable({ ...base, settlesSourceRef: '' }),
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
      const foreignTenant = crypto.randomUUID();
      const foreignLedger = await (
        await LedgerCollection.create({ db })
      ).create({
        tenantId: foreignTenant,
        name: 'Foreign ledger',
        currency: 'CAD',
        balanceMode: 'exact-integer',
      });
      const foreign = await accounts.create({
        tenantId: foreignTenant,
        ledgerId: foreignLedger.id!,
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
      Reflect.set(ledger!, 'balanceMode', 'unsupported-mode');
      await expect(ledger!.save()).rejects.toThrow();
      ledger!.balanceMode = 'exact-integer';
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
    it('denies direct entry writes through foreign or missing parents', async () => {
      enableTenancy();
      const posted = await postReceivable(base);
      const draft = await (await JournalCollection.create({ db })).create({
        tenantId: base.tenantId,
        ledgerId: base.ledgerId,
        description: 'Owned draft',
      });
      const foreignTenant = crypto.randomUUID();
      const attempt = async (journalId: string) => {
        const entries = await JournalEntryCollection.create({ db });
        await expect(
          entries.create({
            tenantId: foreignTenant,
            journalId,
            accountId: base.debitAccountId,
            debit: 1,
            currency: 'CAD',
          }),
        ).rejects.toThrow();
      };
      // Tenant-filtered parent lookup must fail closed, for both posted and draft.
      await withTenant({ tenantId: foreignTenant }, async () => {
        await attempt(posted.id!);
        await attempt(draft.id!);
      });
      // Trusted and privileged lookups may see the parent, but ownership still binds.
      await attempt(draft.id!);
      await withTenant({ tenantId: foreignTenant }, () =>
        withSuperAdminBypass(() => attempt(draft.id!)),
      );
      await expect(
        (await JournalEntryCollection.create({ db })).create({
          tenantId: base.tenantId,
          journalId: crypto.randomUUID(),
          accountId: base.debitAccountId,
          debit: 1,
          currency: 'CAD',
        }),
      ).rejects.toThrow();
      expect(
        (await db.query('SELECT id FROM journal_entries')).rows,
      ).toHaveLength(2);
      expect(await posted.getTotalDebits()).toBe(10000);
      expect(await posted.isBalanced()).toBe(true);
      await withTenant({ tenantId: base.tenantId }, async () => {
        const own = await (await JournalEntryCollection.create({ db })).create({
          journalId: draft.id!,
          accountId: base.debitAccountId,
          debit: 100,
          currency: 'CAD',
        });
        expect(own.tenantId).toBe(base.tenantId);
      });
    });
    it('denies direct legacy-line injection and reassignment into scoped accounts', async () => {
      await withTenant({ tenantId: base.tenantId }, async () => {
        const accounts = await AccountCollection.create({ db });
        const debit = await accounts.create({
          tenantId: base.tenantId,
          name: 'Legacy asset',
          number: '1200',
          type: 'asset',
        });
        const credit = await accounts.create({
          tenantId: base.tenantId,
          name: 'Legacy revenue',
          number: '4100',
          type: 'revenue',
        });
        const journal = await (
          await JournalCollection.create({ db })
        ).createWithEntries({
          tenantId: base.tenantId,
          description: 'Legacy posted',
          entries: [
            { accountId: debit.id!, debit: 10, currency: 'CAD' },
            { accountId: credit.id!, credit: 10, currency: 'CAD' },
          ],
        });
        await journal.post();
        const entries = await JournalEntryCollection.create({ db });
        for (const currency of ['USD', 'CAD']) {
          await expect(
            entries.create({
              tenantId: base.tenantId,
              journalId: journal.id!,
              accountId: base.debitAccountId,
              debit: 1.5,
              currency,
              counterpartyKind: 'client',
              counterpartyId: 'fabricated',
              dueDate: new Date('2026-10-01'),
            }),
          ).rejects.toThrow();
        }
        const line = (await journal.getEntries()).find(
          (entry) => entry.debit > 0,
        )!;
        line.accountId = base.debitAccountId;
        await expect(line.save()).rejects.toThrow();
        const stored = await entries.get({ id: line.id! }, { cache: false });
        expect(stored!.accountId).toBe(debit.id);
        expect(
          (await db.query('SELECT id FROM journal_entries')).rows,
        ).toHaveLength(2);
        const scope = {
          tenantId: base.tenantId,
          accountIds: [base.debitAccountId],
          currency: 'CAD',
          from: new Date('2000-01-01'),
          to: new Date('2100-01-01'),
        };
        expect(await entries.listPostedMovements(scope)).toEqual([]);
        expect(await entries.getCounterpartyBalances(scope)).toEqual([]);
        expect(await entries.getCounterpartyAging(scope, scope.to)).toEqual([]);
        // Existing legacy movements cannot enter a ledger by promoting their account.
        debit.ledgerId = base.ledgerId;
        await expect(debit.save()).rejects.toThrow();
        expect(
          (await accounts.get({ id: debit.id! }, { cache: false }))!.ledgerId,
        ).toBeNull();
        // Normal legacy lines remain editable under the existing compatibility contract.
        stored!.memo = 'Legacy edit';
        await stored!.save();
      });
    });
    it('validates the ledger owner before creating scoped accounts', async () => {
      const otherTenant = crypto.randomUUID();
      const foreignLedger = await (
        await LedgerCollection.create({ db })
      ).create({
        tenantId: otherTenant,
        name: 'Foreign ledger',
        currency: 'CAD',
        balanceMode: 'exact-integer',
      });
      const accounts = await AccountCollection.create({ db });
      const attempt = () =>
        accounts.create({
          tenantId: base.tenantId,
          ledgerId: foreignLedger.id!,
          number: 'bad-owner',
          name: 'Invalid scoped account',
        });
      await expect(attempt()).rejects.toThrow();
      enableTenancy();
      await withTenant({ tenantId: base.tenantId }, async () => {
        await expect(attempt()).rejects.toThrow();
        await expect(withSuperAdminBypass(attempt)).rejects.toThrow();
        const valid = await accounts.create({
          ledgerId: base.ledgerId,
          number: 'valid-owner',
          name: 'Implicit scoped owner',
        });
        expect(valid.tenantId).toBe(base.tenantId);
        await expect(
          accounts.create({
            tenantId: base.tenantId,
            ledgerId: crypto.randomUUID(),
            number: 'missing-ledger',
            name: 'Missing',
          }),
        ).rejects.toThrow();
      });
      expect(
        (await db.query('SELECT id FROM ledger_accounts')).rows,
      ).toHaveLength(3);
    });
    it('inherits persisted scope and owner when creating scoped child accounts', async () => {
      const accounts = await AccountCollection.create({ db });
      const parent = (await accounts.get({ id: base.debitAccountId }))!;
      const child = await parent.createChild({
        number: '1101',
        name: 'Project receivable',
      });
      expect(child).toMatchObject({
        parentId: parent.id,
        ledgerId: base.ledgerId,
        tenantId: base.tenantId,
        type: parent.type,
      });
      const journal = await postReceivable({
        ...base,
        debitAccountId: child.id!,
      });
      expect(await journal.isBalanced()).toBe(true);
      for (const override of [
        { ledgerId: null },
        { ledgerId: crypto.randomUUID() },
        { tenantId: null },
        { tenantId: crypto.randomUUID() },
      ]) {
        await expect(
          parent.createChild({
            number: 'bad-child',
            name: 'Wrong scope',
            ...override,
          }),
        ).rejects.toThrow();
      }
      // Unsaved changes to the caller's parent object cannot change inherited authority.
      parent.ledgerId = null;
      parent.tenantId = crypto.randomUUID();
      const sibling = await parent.createChild({
        number: '1102',
        name: 'Second receivable',
      });
      expect(sibling).toMatchObject({
        ledgerId: base.ledgerId,
        tenantId: base.tenantId,
      });
      expect(
        (await db.query('SELECT id FROM ledger_accounts')).rows,
      ).toHaveLength(4);
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
    it('preserves revision-guarded deletion for legacy accounts', async () => {
      const accounts = await AccountCollection.create({ db });
      const account = await accounts.create({
        tenantId: base.tenantId,
        name: 'Legacy unused',
        number: '9999',
        type: 'asset',
      });
      await expect(
        account.delete({ expectedUpdatedAt: new Date(0) }),
      ).rejects.toThrow();
      expect(await accounts.get({ id: account.id! })).toBeTruthy();
      await account.delete({ expectedUpdatedAt: account.updated_at! });
      expect(await accounts.get({ id: account.id! })).toBeNull();
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
