# @happyvertical/smrt-ledgers

Double-entry accounting ledger for the s-m-r-t framework. Hierarchical chart of accounts, journal lifecycle with immutability after posting, and balance enforcement with epsilon tolerance.

## Installation

```bash
pnpm add @happyvertical/smrt-ledgers
```

## Usage

```typescript
import {
  Account, AccountCollection,
  Journal, JournalCollection,
  JournalEntry, JournalEntryCollection
} from '@happyvertical/smrt-ledgers';

// Set up chart of accounts
const accounts = await AccountCollection.create({ db });
const cash = await accounts.create({
  number: '1000',
  name: 'Cash',
  type: 'asset',
});
await cash.save();

const revenue = await accounts.create({
  number: '4000',
  name: 'Sales Revenue',
  type: 'revenue',
});
await revenue.save();

// Create a sub-account under Cash
const checking = await cash.createChild({
  number: '1010',
  name: 'Checking Account',
});

// Create a balanced journal with entries
const journals = await JournalCollection.create({ db });
const journal = await journals.createWithEntries({
  description: 'Cash sale',
  sourceModule: 'manual',
  entries: [
    { accountId: cash.id, debit: 100.00 },
    { accountId: revenue.id, credit: 100.00 },
  ],
});

// Post the journal (validates balance, then immutable)
await journal.post();

// Query balances
const cashBalance = await cash.getBalance();

// Get trial balance across all active accounts
const entries = await JournalEntryCollection.create({ db });
const trialBalance = await entries.getTrialBalance();

// Void a journal (cannot edit after posting, only void)
await journal.void('Duplicate entry');
```

## Double-Entry Accounting

Every journal must balance before it can be posted. The balance check uses `BALANCE_EPSILON = 0.001` to handle floating-point rounding:

```
Math.abs(totalDebits - totalCredits) < 0.001
```

Account types follow standard accounting rules:
- **Debit-normal** (Asset, Expense): balance = debits - credits
- **Credit-normal** (Liability, Equity, Revenue): balance = credits - debits

### Journal Lifecycle

Journals follow a strict `draft -> posted -> voided` lifecycle:
- **Draft**: editable, entries can be added via `journal.addEntry()`
- **Posted**: immutable, balance validated, `postedAt` timestamp set
- **Voided**: marked with `voidReason` and `voidedAt`, cannot be edited or re-posted

Each JournalEntry must have either a debit or a credit (not both, not zero). Amounts must be non-negative. Multi-currency is supported via `exchangeRate` on each entry.

## API

### Models

| Export | Description |
|--------|------------|
| `Account` | Chart of accounts entry with type, number, hierarchical parent, and balance queries |
| `Journal` | Transaction journal with status lifecycle, auto-numbered (JNL-*), sourceModule/sourceRef for cross-package attribution |
| `JournalEntry` | Individual debit or credit line within a journal, with currency and exchange rate |

### Collections

| Export | Key Methods |
|--------|------------|
| `AccountCollection` | `findChildren()`, `findActive()` |
| `JournalCollection` | `createWithEntries()`, `findByNumber()`, `findByDateRange()`, `findBySource()`, `findByStatus()`, `findDrafts()`, `findPosted()` |
| `JournalEntryCollection` | `findByJournal()`, `findByAccount()`, `getAccountBalance()`, `getTrialBalance()`, `getAccountLedger()`, `getTotalsForDateRange()` |

### Migration

| Export | Description |
|--------|------------|
| `planLedgerAccountsTableMove(db)` | Count the ledger rows a pre-#3098 `accounts` table still holds, without writing |
| `migrateLedgerAccountsTable(db, options?)` | Move them into `ledger_accounts` (see [Upgrading](#upgrading-from-051x-the-ledger_accounts-table-3098)) |
| `LedgerAccountsTableMoveError` | Thrown when the move refuses (uncertain rows, id clash, missing table, non-PostgreSQL) |

### Types

| Export | Description |
|--------|------------|
| `AccountType` | `'asset'`, `'liability'`, `'equity'`, `'revenue'`, `'expense'` |
| `JournalStatus` | `'draft'`, `'posted'`, `'voided'` |
| `AccountOptions` | Options for creating an Account |
| `JournalOptions` | Options for creating a Journal |
| `JournalEntryOptions` | Options for creating a JournalEntry |
| `JournalEntryData` | Entry data for `addEntry()` / `createWithEntries()` |
| `CreateJournalData` | Full journal + entries creation payload |
| `TrialBalanceRow` | Row in trial balance report (accountId, number, name, type, debit/credit balances) |
| `AccountTree` | Tree of account nodes (roots array) |
| `AccountTreeNode` | Single node in account tree (account + children) |

## Upgrading from 0.51.x: the `ledger_accounts` table (#3098)

`Account` is stored in `ledger_accounts`. Earlier releases derived the table
name `accounts`, which `@happyvertical/smrt-messages` also uses for its
unrelated messaging `Account`; an app with both packages got one union table
whose rows each package read as its own. An existing database moves its ledger
accounts once, in a PostgreSQL maintenance window:

1. `smrt db:migrate` — creates `ledger_accounts`. It reports, and does not
   apply, the `journal_entries.account_id` foreign key while the old one still
   points at `accounts`.
2. `smrt db:migrate-ledger-accounts --dry-run`, then without `--dry-run` —
   copies every ledger row (ids, hierarchy and metadata unchanged) into
   `ledger_accounts`, detaches the ledger foreign keys from `accounts`, and
   deletes the moved rows, in one locked transaction. Messaging rows (those
   with an STI discriminator) stay. It refuses a row whose owner is uncertain
   and ids already present in `ledger_accounts`, and a rerun is a no-op.
   The same step is `migrateLedgerAccountsTable(db)` /
   `planLedgerAccountsTableMove(db)` from this package.
3. `smrt db:migrate` — adds the foreign keys against `ledger_accounts`.

Afterwards `accounts` is either empty (ledgers only — drop it when nothing else
uses it) or holds only messaging accounts plus the unused ledger columns
`number`, `type`, `parent_id`, `description`, `active` and `metadata`, which
can be dropped once verified. A database that never ran ledgers needs nothing.

The move supports PostgreSQL. On SQLite, a database whose `accounts` table
holds only ledger accounts is upgraded with
`ALTER TABLE accounts RENAME TO ledger_accounts` before step 1; a SQLite
database that also holds messaging accounts must be rebuilt.

Code that referenced the ledger model by the bare name `'Account'` should use
the constructor or the qualified name `@happyvertical/smrt-ledgers:Account`;
the exported `Account` and `AccountCollection` are unchanged.

## Dependencies

- `@happyvertical/smrt-core` -- ORM and code generation
- `@happyvertical/smrt-tenancy` -- multi-tenant scoping

## Contributor guide

See [`AGENTS.md`](./AGENTS.md) for package architecture, invariants, validation,
and contributor guidance.
