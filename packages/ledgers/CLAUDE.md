# @happyvertical/smrt-ledgers

Double-entry accounting ledger system with chart of accounts, journal entries, and financial reporting.

## Architecture

```
src/
  index.ts              # Export barrel
  models/
    Account.ts          # Chart of accounts entry
    Journal.ts          # Financial event container
    JournalEntry.ts     # Individual debit/credit line
  collections/
    Accounts.ts         # AccountCollection with hierarchy
    Journals.ts         # JournalCollection with numbering
    JournalEntries.ts   # JournalEntryCollection
  types.ts              # AccountType, JournalStatus, TrialBalanceRow
```

## Key Models

- `Account` — Chart of accounts: number, name, type (asset/liability/equity/revenue/expense), parent hierarchy
- `Journal` — Financial event container: status lifecycle (draft → posted → voided), immutable after posting
- `JournalEntry` — Individual debit or credit line tied to account and journal

## Key Patterns

- **Double-entry enforcement**: Debits must equal credits within a journal
- **Status lifecycle**: draft → posted (immutable) → voided
- **Account hierarchy**: Parent-child relationships for account trees
- **Trial balance**: Built-in reporting methods
- **Multi-tenancy**: Optional tenant scoping via `@TenantScoped`

## Dependencies

- `@happyvertical/smrt-core`, `@happyvertical/smrt-tenancy`
