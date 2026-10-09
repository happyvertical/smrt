/**
 * Declared recipes for smrt-ledgers (#3590, #3604): user-facing units of
 * functionality an app or agent can pick instead of the whole package.
 * The scanner reads these statics into the `recipes` array of `manifest.json`
 * and `smrt-knowledge.json`; nothing here runs at that point.
 *
 * @packageDocumentation
 */

import { SmrtRecipe } from '@happyvertical/smrt-core';
import { Account } from './models/Account.js';
import { Journal } from './models/Journal.js';
import { JournalEntry } from './models/JournalEntry.js';

/** Bookkeeping: Keep your books: a chart of accounts and double-entry journals. */
export class BookkeepingRecipe extends SmrtRecipe {
  static id = 'ledgers.bookkeeping';
  static help = './bookkeeping.recipe.md';
  static label = 'Bookkeeping';
  static summary =
    'Keep your books: a chart of accounts and double-entry journals.';
  static synonyms = [
    'accounting',
    'ledger',
    'general ledger',
    'journals',
    'chart of accounts',
  ];
  static section = {
    id: 'accounting',
    label: 'Accounting',
    icon: 'bank',
    description: 'Your books: accounts, journals and balances.',
  };
  static models = [Account, Journal, JournalEntry];
  static nav = [
    {
      label: 'Accounts',
      model: Account,
      icon: 'bank',
      description:
        'The accounts your books are kept in, like sales, rent and bank.',
    },
    {
      label: 'Journals',
      model: Journal,
      icon: 'book',
      description:
        'The entries behind your accounts, so every dollar has a trail.',
    },
  ];
  static options = {
    Account: {
      fields: {
        metadata: { visibility: 'hidden' },
        parentId: { visibility: 'hidden' },
      },
    },
    Journal: {
      fields: {
        sourceModule: { visibility: 'hidden' },
        sourceRef: { visibility: 'hidden' },
        voidedAt: { visibility: 'hidden' },
        voidReason: { visibility: 'hidden' },
        metadata: { visibility: 'hidden' },
      },
    },
    JournalEntry: {
      fields: {
        exchangeRate: { visibility: 'hidden' },
        metadata: { visibility: 'hidden' },
      },
    },
  } as const;
}
