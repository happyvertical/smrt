/**
 * The ledger Account lives in `ledger_accounts` (#3098): journal entries
 * reference it there and resolve their account, journal and description
 * through it.
 */
import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountCollection } from '../collections/Accounts';
import { JournalEntryCollection } from '../collections/JournalEntries';
import { JournalCollection } from '../collections/Journals';
import { Account } from '../models/Account';
import { JournalEntry } from '../models/JournalEntry';

describe('ledger accounts storage (#3098)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  });
  afterEach(async () => {
    await db.close?.();
  });

  it('stores accounts in ledger_accounts and references them there', async () => {
    expect(
      ObjectRegistry.getClassByConstructor(Account)?.schema?.tableName,
    ).toBe('ledger_accounts');
    const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
    expect(schemas.journal_entries.columns.account_id?.foreignKey?.table).toBe(
      'ledger_accounts',
    );
    expect(schemas.ledger_accounts.columns.parent_id?.foreignKey?.table).toBe(
      'ledger_accounts',
    );

    const accounts = await AccountCollection.create({ db });
    const cash = await accounts.create({
      number: '1000',
      name: 'Cash',
      type: 'asset',
    });
    const rows = await db.query('SELECT name FROM ledger_accounts');
    expect(rows.rows).toEqual([{ name: 'Cash' }]);
    expect(cash.id).toBeTruthy();
  });

  it('resolves an entry’s account, journal and description', async () => {
    const accounts = await AccountCollection.create({ db });
    const cash = await accounts.create({
      number: '1000',
      name: 'Cash',
      type: 'asset',
    });
    const revenue = await accounts.create({
      number: '4000',
      name: 'Sales',
      type: 'revenue',
    });
    const journal = await (
      await JournalCollection.create({ db })
    ).createWithEntries({
      description: 'Sale',
      entries: [
        { accountId: String(cash.id), debit: 25, memo: 'till' },
        { accountId: String(revenue.id), credit: 25 },
      ],
    });
    const entries = await (
      await JournalEntryCollection.create({ db })
    ).findByJournal(String(journal.id));
    const debit = entries.find((entry) => entry.isDebit());
    const credit = entries.find((entry) => entry.isCredit());

    expect((await debit?.getAccount())?.id).toBe(cash.id);
    expect((await debit?.getJournal())?.id).toBe(journal.id);
    expect(await debit?.getDescription()).toBe('DR Cash: $25.00 - till');
    expect(await credit?.getDescription()).toBe('CR Sales: $25.00');

    const detached = new JournalEntry({ debit: 1 });
    expect(await detached.getAccount()).toBeNull();
    expect(await detached.getJournal()).toBeNull();
  });
});
