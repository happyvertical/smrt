# @happyvertical/smrt-ledgers

Double-entry accounting ledger for the SMRT framework. Hierarchical chart of accounts, journal lifecycle with immutability after posting, and balance enforcement with epsilon tolerance.

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
const accounts = new AccountCollection(db);
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
const journals = new JournalCollection(db);
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
const entries = new JournalEntryCollection(db);
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

## Dependencies

- `@happyvertical/smrt-core` -- ORM and code generation
- `@happyvertical/smrt-tenancy` -- multi-tenant scoping
