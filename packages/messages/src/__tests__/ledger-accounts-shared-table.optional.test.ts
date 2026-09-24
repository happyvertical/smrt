/**
 * PostgreSQL lane for #3098 with smrt-messages and smrt-ledgers both loaded.
 *
 * Both packages declare `Account`. Before #3098 both mapped to `accounts`, so
 * a database migrated with both held one union table: messaging rows (with
 * an STI discriminator) and ledger rows side by side. This lane checks the two
 * models now live apart on PostgreSQL, then builds that legacy union table and
 * moves the ledger rows out with the documented operator sequence. Named
 * `*.optional.test.ts` so the package's `test:postgres` script runs it; it
 * skips itself without PostgreSQL.
 */
import '../index';
import '@happyvertical/smrt-ledgers';

import {
  type DatabaseInterface,
  migrateSmrtSchemas,
} from '@happyvertical/smrt-core/migrations';
import {
  JournalCollection,
  AccountCollection as LedgerAccountCollection,
  LedgerAccountsTableMoveError,
  migrateLedgerAccountsTable,
  planLedgerAccountsTableMove,
} from '@happyvertical/smrt-ledgers';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountCollection } from '../collections/AccountCollection';
import { assertMessagingAndLedgerAccountsCoexist } from './helpers/ledger-coexistence';
import {
  foreignKeyTargets,
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

describePostgres('messaging and ledger accounts on PostgreSQL (#3098)', () => {
  const scratch = withScratchDatabase(beforeEach, afterEach);

  it('keeps each Account in its own table', async () => {
    scratch.track(
      await assertMessagingAndLedgerAccountsCoexist({
        type: 'postgres',
        url: scratch.url(),
      }),
    );
  });

  /**
   * The 0.51.24 union table: ledger columns merged onto `accounts`, ledger
   * rows (no discriminator) beside messaging rows, journal entries pointing
   * at `accounts`.
   */
  async function legacyUnionTable(db: DatabaseInterface) {
    const messaging = await AccountCollection.create({ db });
    const inbox = await messaging.create({
      name: 'Inbox',
      providerType: 'email',
      channelType: 'email',
    });
    await inbox.save();
    const ledger = await LedgerAccountCollection.create({ db });
    const assets = await ledger.create({
      number: '1000',
      name: 'Assets',
      type: 'asset',
    });
    const cash = await assets.createChild({ number: '1010', name: 'Cash' });
    const revenue = await ledger.create({
      number: '4000',
      name: 'Revenue',
      type: 'revenue',
    });
    const journal = await (
      await JournalCollection.create({ db })
    ).createWithEntries({
      description: 'Sale',
      entries: [
        { accountId: String(cash.id), debit: 250 },
        { accountId: String(revenue.id), credit: 250 },
      ],
    });
    await journal.post();

    await db.query(`ALTER TABLE accounts
      ADD COLUMN IF NOT EXISTS number TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'asset',
      ADD COLUMN IF NOT EXISTS parent_id UUID,
      ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS metadata JSON DEFAULT '{}'`);
    await db.query(
      'ALTER TABLE accounts ALTER COLUMN _meta_type DROP NOT NULL',
    );
    await db.query(`INSERT INTO accounts (id, slug, context, created_at,
        updated_at, tenant_id, name, number, type, parent_id, description,
        active, metadata)
      SELECT id, slug, context, created_at, updated_at, tenant_id, name,
        number, type, parent_id, description, active, metadata
        FROM ledger_accounts`);
    const [journalForeignKey] = (
      await db.query(
        `SELECT conname FROM pg_constraint
          WHERE conrelid = 'journal_entries'::regclass AND contype = 'f'
            AND confrelid = 'ledger_accounts'::regclass`,
      )
    ).rows as Array<{ conname: string }>;
    await db.query(
      `ALTER TABLE journal_entries DROP CONSTRAINT "${journalForeignKey?.conname}"`,
    );
    await db.query(`ALTER TABLE journal_entries
      ADD CONSTRAINT legacy_journal_account FOREIGN KEY (account_id)
      REFERENCES accounts (id)`);
    await db.query('DELETE FROM ledger_accounts');
    return { inbox, assets, cash, revenue };
  }

  it('moves ledger rows out of the union table and leaves messaging rows', async () => {
    const db = await scratch.database();
    const { inbox, assets, cash, revenue } = await legacyUnionTable(db);
    expect(await planLedgerAccountsTableMove(db)).toEqual({
      legacyTable: true,
      pending: 3,
      messagingRows: 1,
    });

    const moved = await migrateLedgerAccountsTable(db);
    expect(moved).toEqual({
      ran: true,
      moved: 3,
      remainingLegacyRows: 1,
      detachedForeignKeys: ['journal_entries.account_id'],
    });
    await dbMigrate(db);
    expect(
      await foreignKeyTargets(db, 'journal_entries', 'account_id'),
    ).toEqual(['ledger_accounts']);

    const ledger = await LedgerAccountCollection.create({ db });
    const accounts = await ledger.list({
      where: { number: ['1000', '1010', '4000'] },
      orderBy: 'number ASC',
    });
    expect(accounts.map((account) => account.id)).toEqual([
      assets.id,
      cash.id,
      revenue.id,
    ]);
    expect(await accounts[1]?.getBalance()).toBe(250);
    const messaging = await AccountCollection.create({ db });
    expect((await messaging.list({})).map((account) => account.id)).toEqual([
      inbox.id,
    ]);
    expect(await migrateLedgerAccountsTable(db)).toMatchObject({
      ran: false,
      remainingLegacyRows: 1,
    });
  });

  it('refuses a row whose owner is uncertain and changes nothing', async () => {
    const db = await scratch.database();
    const { inbox } = await legacyUnionTable(db);
    await db.query(
      "UPDATE accounts SET number = '9999' WHERE id = ?",
      inbox.id,
    );
    await expect(migrateLedgerAccountsTable(db)).rejects.toThrow(
      LedgerAccountsTableMoveError,
    );
    expect(
      await planLedgerAccountsTableMove(db).catch((e) => e),
    ).toBeInstanceOf(LedgerAccountsTableMoveError);
    const rows = await db.query('SELECT COUNT(*) AS n FROM accounts');
    expect(Number((rows.rows[0] as { n: string }).n)).toBe(4);
    expect(
      await foreignKeyTargets(db, 'journal_entries', 'account_id'),
    ).toEqual(['accounts']);
  });
});
