/**
 * Shared assertions for smrt-ledgers and smrt-messages loaded in one process
 * (#3098). Both packages declare an `Account`; each must keep its own
 * registry identity, fields and table whichever package loads first. The
 * callers differ only in import order, which each fixes with side-effect
 * imports ahead of this module.
 */
import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import {
  Account as LedgerAccount,
  AccountCollection as LedgerAccountCollection,
} from '@happyvertical/smrt-ledgers';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect } from 'vitest';
import { AccountCollection } from '../../collections/AccountCollection';
import { Account } from '../../models/Account';

export async function assertMessagingAndLedgerAccountsCoexist(
  dbOptions:
    | { type: 'sqlite'; url: string }
    | { type: 'postgres'; url: string },
): Promise<DatabaseInterface> {
  const ledger = ObjectRegistry.getClassByConstructor(LedgerAccount);
  const messaging = ObjectRegistry.getClassByConstructor(Account);
  expect(ledger?.qualifiedName).toBe('@happyvertical/smrt-ledgers:Account');
  expect(messaging?.qualifiedName).toBe('@happyvertical/smrt-messages:Account');
  expect(ledger?.schema?.tableName).toBe('ledger_accounts');
  expect(messaging?.schema?.tableName).toBe('accounts');
  expect([...(ledger?.fields.keys() ?? [])]).toEqual(
    expect.arrayContaining(['number', 'type', 'parentId']),
  );
  expect([...(messaging?.fields.keys() ?? [])]).toEqual(
    expect.arrayContaining(['providerType', 'channelType']),
  );

  // Test-database manifest discovery must not report a class-name collision.
  const db = await getTestDatabase(dbOptions);
  const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
  expect(Object.keys(schemas.ledger_accounts.columns)).toEqual(
    expect.arrayContaining(['number', 'type', 'parent_id']),
  );
  expect(Object.keys(schemas.accounts.columns)).not.toContain('number');
  expect(schemas.journal_entries.columns.account_id?.foreignKey?.table).toBe(
    'ledger_accounts',
  );

  const ledgerAccounts = await LedgerAccountCollection.create({ db });
  const messagingAccounts = await AccountCollection.create({ db });
  const cash = await ledgerAccounts.create({
    number: '1000',
    name: 'Cash',
    type: 'asset',
  });
  await cash.save();
  const inbox = await messagingAccounts.create({
    name: 'Inbox',
    providerType: 'email',
    channelType: 'email',
  });
  await inbox.save();

  // Each package queries its own fields and sees only its own rows.
  const byNumber = await ledgerAccounts.list({ where: { number: ['1000'] } });
  expect(byNumber.map((account) => account.name)).toEqual(['Cash']);
  expect((await ledgerAccounts.list({})).map((a) => a.id)).toEqual([cash.id]);
  const byProvider = await messagingAccounts.list({
    where: { providerType: 'email' },
  });
  expect(byProvider.map((account) => account.id)).toEqual([inbox.id]);
  expect((await messagingAccounts.list({})).map((a) => a.id)).toEqual([
    inbox.id,
  ]);
  return db;
}
