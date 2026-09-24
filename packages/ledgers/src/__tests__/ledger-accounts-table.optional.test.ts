/**
 * PostgreSQL lane for the ledger accounts table move (#3098), ledgers only.
 *
 * Before #3098 the ledger `Account` lived in `accounts`. This lane builds that
 * exact legacy state — the current schema with `ledger_accounts` renamed back
 * to `accounts`, journal entries referencing it — then runs the documented
 * operator sequence: `db:migrate`, the table move, `db:migrate`. Named
 * `*.optional.test.ts` so the package's `test:postgres` script runs it; it
 * skips itself without PostgreSQL.
 */
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  type DatabaseInterface,
  migrateSmrtSchemas,
} from '@happyvertical/smrt-core/migrations';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountCollection } from '../collections/Accounts';
import { JournalCollection } from '../collections/Journals';
import {
  LedgerAccountsTableMoveError,
  migrateLedgerAccountsTable,
  planLedgerAccountsTableMove,
} from '../migrations/ledger-accounts-table';
import {
  foreignKeyTargets,
  renameTableWithIndexes,
  withScratchDatabase,
} from './helpers/postgres-scratch';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

/** `smrt db:migrate`: one atomic, uniquely named schema sync. */
function dbMigrate(db: DatabaseInterface) {
  return migrateSmrtSchemas({
    db,
    packageName: 'ledger-move-test',
    name: `ledger_move_${crypto.randomUUID().replace(/-/g, '')}`,
    postgresSafe: false,
  });
}

describePostgres('ledger accounts table move on PostgreSQL (#3098)', () => {
  const scratch = withScratchDatabase(beforeEach, afterEach);

  async function legacyLedger(db: DatabaseInterface) {
    const accounts = await AccountCollection.create({ db });
    const assets = await accounts.create({
      number: '1000',
      name: 'Assets',
      type: 'asset',
    });
    const cash = await assets.createChild({ number: '1010', name: 'Cash' });
    const revenue = await accounts.create({
      number: '4000',
      name: 'Revenue',
      type: 'revenue',
    });
    const journals = await JournalCollection.create({ db });
    const journal = await journals.createWithEntries({
      description: 'Sale',
      entries: [
        { accountId: String(cash.id), debit: 250 },
        { accountId: String(revenue.id), credit: 250 },
      ],
    });
    await journal.post();
    // The pre-#3098 table: same shape, named `accounts`.
    await renameTableWithIndexes(db, 'ledger_accounts', 'accounts');
    return { assets, cash, revenue };
  }

  it('moves a ledger-only accounts table through the documented sequence', async () => {
    const db = await scratch.database();
    const { assets, cash, revenue } = await legacyLedger(db);
    expect(
      await foreignKeyTargets(db, 'journal_entries', 'account_id'),
    ).toEqual(['accounts']);
    expect(await planLedgerAccountsTableMove(db)).toEqual({
      legacyTable: true,
      pending: 3,
      messagingRows: 0,
    });

    // 1. db:migrate creates ledger_accounts; the retargeted journal FK is
    // reported, not applied, while the old constraint still points at
    // accounts.
    await dbMigrate(db);
    expect(
      await foreignKeyTargets(db, 'journal_entries', 'account_id'),
    ).toEqual(['accounts']);

    // 2. The move.
    const moved = await migrateLedgerAccountsTable(db);
    expect(moved).toEqual({
      ran: true,
      moved: 3,
      remainingLegacyRows: 0,
      detachedForeignKeys: ['journal_entries.account_id'],
    });
    const legacyRows = await db.query('SELECT COUNT(*) AS n FROM accounts');
    expect(Number((legacyRows.rows[0] as { n: string }).n)).toBe(0);

    // 3. db:migrate adds the journal FK onto ledger_accounts.
    await dbMigrate(db);
    expect(
      await foreignKeyTargets(db, 'journal_entries', 'account_id'),
    ).toEqual(['ledger_accounts']);

    // Ids, hierarchy and balances survive.
    const accounts = await AccountCollection.create({ db });
    const byNumber = await accounts.list({
      where: { number: ['1000', '1010', '4000'] },
      orderBy: 'number ASC',
    });
    expect(byNumber.map((account) => account.id)).toEqual([
      assets.id,
      cash.id,
      revenue.id,
    ]);
    const movedCash = byNumber[1];
    expect((await movedCash?.getParent())?.id).toBe(assets.id);
    expect(await movedCash?.getBalance()).toBe(250);

    // Idempotent: a rerun and the plan both see nothing left.
    expect(await migrateLedgerAccountsTable(db)).toMatchObject({
      ran: false,
      moved: 0,
    });
    expect(await planLedgerAccountsTableMove(db)).toMatchObject({
      pending: 0,
    });
  });

  it('is a no-op on a database that never had a ledger accounts table', async () => {
    const db = await scratch.database();
    expect(await planLedgerAccountsTableMove(db)).toEqual({
      legacyTable: false,
      pending: 0,
      messagingRows: 0,
    });
    expect(await migrateLedgerAccountsTable(db)).toEqual({
      ran: false,
      moved: 0,
      remainingLegacyRows: 0,
      detachedForeignKeys: [],
    });
  });

  it('refuses before db:migrate has created ledger_accounts', async () => {
    const db = await scratch.database();
    await legacyLedger(db);
    await expect(migrateLedgerAccountsTable(db)).rejects.toThrow(
      LedgerAccountsTableMoveError,
    );
    await expect(migrateLedgerAccountsTable(db)).rejects.toThrow(
      /run db:migrate before moving ledger accounts/,
    );
  });

  it('refuses, changing nothing, while an undeclared foreign key references a ledger row', async () => {
    const db = await scratch.database();
    const { cash } = await legacyLedger(db);
    await dbMigrate(db);
    // An application table no registered model describes.
    await db.query(
      'CREATE TABLE app_account_refs (account_id UUID REFERENCES accounts (id))',
    );
    await db.query(
      'INSERT INTO app_account_refs (account_id) VALUES (?)',
      cash.id,
    );
    await expect(migrateLedgerAccountsTable(db)).rejects.toThrow(
      /still references ledger accounts/,
    );
    const legacyRows = await db.query('SELECT COUNT(*) AS n FROM accounts');
    expect(Number((legacyRows.rows[0] as { n: string }).n)).toBe(3);
    const movedRows = await db.query(
      'SELECT COUNT(*) AS n FROM ledger_accounts',
    );
    expect(Number((movedRows.rows[0] as { n: string }).n)).toBe(0);
    expect(
      await foreignKeyTargets(db, 'journal_entries', 'account_id'),
    ).toEqual(['accounts']);
  });

  it('refuses to overwrite ids already present in ledger_accounts, changing nothing', async () => {
    const db = await scratch.database();
    const { cash } = await legacyLedger(db);
    await dbMigrate(db);
    await db.query(
      `INSERT INTO ledger_accounts (id, slug, context, number, name, type)
       SELECT id, slug, context, number, name, type FROM accounts WHERE id = ?`,
      cash.id,
    );
    await expect(migrateLedgerAccountsTable(db)).rejects.toThrow(
      /refusing to overwrite/,
    );
    const legacyRows = await db.query('SELECT COUNT(*) AS n FROM accounts');
    expect(Number((legacyRows.rows[0] as { n: string }).n)).toBe(3);
    expect(
      await foreignKeyTargets(db, 'journal_entries', 'account_id'),
    ).toEqual(['accounts']);
  });
});
