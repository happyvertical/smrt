/**
 * The ledger accounts table move's portable parts (#3098), on SQLite: legacy
 * table detection and row classification, the dry-run plan, the foreign-key
 * decisions and copy list the PostgreSQL move is built from, and its refusal
 * on other engines. The move itself runs in `ledger-accounts-table.optional.test.ts`.
 */
import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../index';
import {
  classifyForeignKeys,
  copySelectList,
  foreignKeyRefusal,
  LedgerAccountsTableMoveError,
  type LegacyForeignKey,
  migrateLedgerAccountsTable,
  planLedgerAccountsTableMove,
  registeredReferenceColumns,
} from '../migrations/ledger-accounts-table';

const fk = (table: string, column: string, arity = 1): LegacyForeignKey => ({
  constraint: `${table}_${column}_fkey`,
  table,
  column,
  arity,
});

describe('ledger accounts table move — portable parts (#3098)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  });
  afterEach(async () => {
    await db.close?.();
  });

  it('plans nothing without a legacy ledger table', async () => {
    expect(await planLedgerAccountsTableMove(db)).toEqual({
      legacyTable: false,
      pending: 0,
      messagingRows: 0,
    });
    await db.query('CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT)');
    expect(await planLedgerAccountsTableMove(db)).toMatchObject({
      legacyTable: false,
    });
  });

  it('counts every row of a ledger-only accounts table as pending', async () => {
    await db.query(
      'CREATE TABLE accounts (id TEXT PRIMARY KEY, number TEXT, type TEXT)',
    );
    await db.query(
      "INSERT INTO accounts VALUES ('a', '1000', 'asset'), ('b', '4000', 'revenue')",
    );
    expect(await planLedgerAccountsTableMove(db)).toEqual({
      legacyTable: true,
      pending: 2,
      messagingRows: 0,
    });
  });

  describe('a union table shared with messaging', () => {
    beforeEach(async () => {
      await db.query(`CREATE TABLE accounts (
        id TEXT PRIMARY KEY, _meta_type TEXT, number TEXT, type TEXT,
        provider_type TEXT, channel_type TEXT)`);
      await db.query(`INSERT INTO accounts VALUES
        ('l1', NULL, '1000', 'asset', NULL, NULL),
        ('l2', '', '4000', 'revenue', '', ''),
        ('m1', '@happyvertical/smrt-messages:EmailAccount', '', 'asset', 'smtp', 'email')`);
    });

    it('separates ledger rows (no discriminator) from messaging rows', async () => {
      expect(await planLedgerAccountsTableMove(db)).toEqual({
        legacyTable: true,
        pending: 2,
        messagingRows: 1,
      });
    });

    it('refuses a messaging row carrying a ledger account number', async () => {
      await db.query("UPDATE accounts SET number = '9999' WHERE id = 'm1'");
      await expect(planLedgerAccountsTableMove(db)).rejects.toThrow(
        /1 messaging row\(s\) carry a ledger account number and 0 ledger row/,
      );
    });

    it('refuses a ledger row carrying a messaging provider', async () => {
      await db.query("UPDATE accounts SET provider_type = 'x' WHERE id = 'l1'");
      await expect(planLedgerAccountsTableMove(db)).rejects.toThrow(
        LedgerAccountsTableMoveError,
      );
    });
  });

  it('refuses to move on an engine other than PostgreSQL', async () => {
    await expect(migrateLedgerAccountsTable(db)).rejects.toThrow(
      /supports PostgreSQL only.*RENAME TO ledger_accounts/,
    );
  });

  it('knows the registered references into both tables', () => {
    const references = registeredReferenceColumns();
    expect([...references.ledger]).toContain('journal_entries.account_id');
    expect([...references.ledger]).toContain('ledger_accounts.parent_id');
  });

  describe('foreign-key decisions', () => {
    const references = {
      ledger: new Set(['journal_entries.account_id']),
      accounts: new Set(['messages.account_id']),
    };

    it('detaches ledger references and keeps messaging and self links', () => {
      const disposition = classifyForeignKeys(
        [
          fk('journal_entries', 'account_id'),
          fk('messages', 'account_id'),
          fk('accounts', 'parent_id'),
        ],
        references,
      );
      expect(disposition.detach.map((f) => f.table)).toEqual([
        'journal_entries',
      ]);
      expect(disposition.keep.map((f) => f.table)).toEqual([
        'messages',
        'accounts',
      ]);
      expect(foreignKeyRefusal(disposition)).toBeUndefined();
    });

    it('refuses an undeclared reference with retarget guidance', () => {
      const refusal = foreignKeyRefusal(
        classifyForeignKeys([fk('app_refs', 'account_id')], references),
      );
      expect(refusal).toMatch(
        /app_refs\.account_id reference "accounts" but no registered model declares them.*retarget/,
      );
    });

    it('refuses a composite reference by constraint, even on a ledger column', () => {
      const disposition = classifyForeignKeys(
        [fk('journal_entries', 'account_id', 2)],
        references,
      );
      expect(disposition.detach).toEqual([]);
      expect(foreignKeyRefusal(disposition)).toMatch(
        /Composite foreign key\(s\) journal_entries_account_id_fkey on journal_entries \(2 columns\).*Drop it, or replace it/,
      );
    });
  });

  describe('copy list', () => {
    it('copies same-typed columns as they are', () => {
      expect(
        copySelectList(
          ['id', 'name'],
          { id: 'UUID', name: 'TEXT' },
          { id: 'uuid', name: 'TEXT' },
        ),
      ).toBe('"id", "name"');
    });

    it('converts a differently typed column through text', () => {
      expect(copySelectList(['id'], { id: 'UUID' }, { id: 'TEXT' })).toBe(
        'CAST(CAST("id" AS TEXT) AS UUID)',
      );
    });

    it('rejects a target type it cannot render safely', () => {
      expect(() =>
        copySelectList(['id'], { id: 'UUID); DROP TABLE x;--' }, {}),
      ).toThrow(/unsupported live column type/);
      expect(() => copySelectList(['id'], {}, { id: 'TEXT' })).toThrow(
        LedgerAccountsTableMoveError,
      );
    });
  });
});
