# @happyvertical/smrt-ledgers

Double-entry accounting ledger for the SMRT framework. Enforces balanced journals with epsilon tolerance (0.01), hierarchical chart of accounts, and full journal lifecycle management.

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
  name: 'Cash',
  code: '1000',
  type: 'asset',
});
const revenue = await accounts.create({
  name: 'Revenue',
  code: '4000',
  type: 'revenue',
});
await cash.save();
await revenue.save();

// Create a balanced journal
const journals = new JournalCollection(db);
const journal = await journals.create({
  description: 'Sales receipt',
  status: 'draft',
});
await journal.save();

// Add entries (must balance: debits = credits)
const entries = new JournalEntryCollection(db);
await entries.create({
  journalId: journal.id,
  accountId: cash.id,
  debit: 100.00,
  credit: 0.0,
});
await entries.create({
  journalId: journal.id,
  accountId: revenue.id,
  debit: 0.0,
  credit: 100.00,
});
```

## API

### Models

| Export | Description |
|--------|------------|
| `Account` | Chart of accounts entry with type, code, and parent hierarchy |
| `Journal` | Transaction journal with status lifecycle and balance enforcement |
| `JournalEntry` | Individual debit/credit entry within a journal |

### Collections

`AccountCollection`, `JournalCollection`, `JournalEntryCollection`

### Key Types

`AccountType` (`asset`, `liability`, `equity`, `revenue`, `expense`), `AccountTree`, `AccountTreeNode`, `JournalStatus`, `TrialBalanceRow`, `CreateJournalData`, `JournalEntryData`

## Dependencies

- `@happyvertical/smrt-core` — ORM and code generation
- `@happyvertical/smrt-tenancy` — multi-tenant scoping
