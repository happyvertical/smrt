/**
 * @happyvertical/smrt-ledgers
 *
 * Double-entry accounting ledger for the SMRT framework.
 *
 * This package provides models for managing a general ledger with proper
 * double-entry accounting: every journal must balance (debits = credits).
 *
 * @example
 * ```typescript
 * import {
 *   Account,
 *   AccountCollection,
 *   Journal,
 *   JournalCollection,
 *   JournalEntry,
 *   JournalEntryCollection
 * } from '@happyvertical/smrt-ledgers';
 *
 * // Create collections
 * const accounts = await AccountCollection.create({
 *   db: { type: 'sqlite', url: 'ledger.db' }
 * });
 * const journals = await JournalCollection.create({
 *   db: { type: 'sqlite', url: 'ledger.db' }
 * });
 *
 * // Create chart of accounts
 * const cash = await accounts.create({
 *   number: '1000',
 *   name: 'Cash',
 *   type: 'asset'
 * });
 * await cash.save();
 *
 * const revenue = await accounts.create({
 *   number: '4000',
 *   name: 'Sales Revenue',
 *   type: 'revenue'
 * });
 * await revenue.save();
 *
 * // Create a balanced journal entry (IDs guaranteed after save())
 * const journal = await journals.createWithEntries({
 *   description: 'Cash sale',
 *   entries: [
 *     { accountId: cash.id!, debit: 100 },
 *     { accountId: revenue.id!, credit: 100 }
 *   ]
 * });
 *
 * // Post the journal (finalize it)
 * await journal.post();
 *
 * // Get account balance
 * const cashBalance = await cash.getBalance();
 * console.log(`Cash balance: $${cashBalance}`);
 * ```
 *
 * @packageDocumentation
 */

// Export collections
export { AccountCollection } from './collections/Accounts';
export { JournalEntryCollection } from './collections/JournalEntries';
export { JournalCollection } from './collections/Journals';

// Export models
export { Account } from './models/Account';
export { Journal } from './models/Journal';
export { JournalEntry } from './models/JournalEntry';

// Export types
export type {
  AccountOptions,
  AccountTree,
  AccountTreeNode,
  AccountType,
  CreateJournalData,
  JournalEntryData,
  JournalEntryOptions,
  JournalOptions,
  JournalStatus,
  TrialBalanceRow,
} from './types';
