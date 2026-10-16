import { GlobalInterceptors } from '@happyvertical/smrt-core';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { AccountCollection } from '../collections/Accounts';
import { JournalEntryCollection } from '../collections/JournalEntries';
import { JournalCollection } from '../collections/Journals';
import { LedgerCollection } from '../collections/Ledgers';
import { JournalEntry } from '../models/JournalEntry';
import { withScratchDatabase } from './helpers/postgres-scratch';

const scratch = withScratchDatabase(beforeEach, afterEach);
afterEach(() => GlobalInterceptors.unregister('scope-transition-probe'));
(isPostgresAvailable() ? it : it.skip)(
  'cannot scope a legacy parent while its validated entry insert is paused',
  async () => {
    const db = await scratch.database();
    const other = await scratch.database();
    const tenantId = crypto.randomUUID();
    const accounts = await AccountCollection.create({ db });
    const legacy = await accounts.create({
      tenantId,
      name: 'Legacy',
      type: 'asset',
      number: 'L',
    });
    const ledger = await (await LedgerCollection.create({ db })).create({
      tenantId,
      name: 'Exact',
      currency: 'CAD',
      balanceMode: 'exact-integer',
    });
    const parent = await (await JournalCollection.create({ db })).create({
      tenantId,
      description: 'Initially legacy',
    });
    let release!: () => void;
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let insertPid = 0;
    GlobalInterceptors.register({
      name: 'scope-transition-probe',
      async beforeSave(instance) {
        if (
          instance instanceof JournalEntry &&
          instance.memo === 'paused-legacy'
        ) {
          insertPid = Number(
            (await instance.db.query('SELECT pg_backend_pid() AS pid')).rows[0]
              .pid,
          );
          reached();
          await resume;
        }
      },
    });
    const pending = (await JournalEntryCollection.create({ db })).create({
      tenantId,
      journalId: parent.id!,
      accountId: legacy.id!,
      debit: 7,
      currency: 'CAD',
      memo: 'paused-legacy',
    });
    const settled = pending.then(
      (value) => ({ status: 'fulfilled', id: value.id }),
      (error) => ({ status: 'rejected', error: String(error) }),
    );
    try {
      await paused;
      const otherPid = Number(
        (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
      );
      expect(otherPid).not.toBe(insertPid);
      const moving = (await (
        await JournalCollection.create({ db: other })
      ).get(parent.id!, { cache: false }))!;
      moving.ledgerId = ledger.id!;
      // The transition must fail before any scoped posting can race this insert.
      await expect(moving.save()).rejects.toThrow();
      release();
      const outcome = await settled;
      const stored = (await (
        await JournalCollection.create({ db: other })
      ).get(parent.id!, { cache: false }))!;
      expect(outcome.status).toBe('fulfilled');
      expect(stored.ledgerId).toBeNull();
      expect(stored.status).toBe('draft');
      expect(await stored.getTotalDebits()).toBe(7);
      expect(await stored.getEntries()).toHaveLength(1);
    } finally {
      release();
      await settled;
    }
  },
  15000,
);
