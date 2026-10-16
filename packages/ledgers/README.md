# @happyvertical/smrt-ledgers

Double-entry accounting ledger for the s-m-r-t framework. Hierarchical chart of accounts, journal lifecycle with immutability after posting, and balance enforcement with epsilon tolerance.

## Exact ledgers and counterparties

Create a `Ledger` with `balanceMode: 'exact-integer'` and an ISO currency when
the accounting scope stores minor units. Accounts and journals assigned to that
ledger must share its tenant and currency; posting rejects fractional or unsafe
amounts and requires exactly equal debit and credit totals. Existing journals
without a ledger retain the compatible tolerant decimal rule. Direct entry
writes also require an accessible same-owner journal and matching account/journal
ledger scope; legacy journals cannot write movements on scoped accounts. An
existing account cannot change ledger scope, including adoption from an unassigned
account; create a fresh scoped account instead. Scoped-account creation validates
the referenced ledger owner. `createChild()` inherits the persisted scoped parent
ledger and owner and rejects conflicting overrides.

`JournalEntry` carries opaque `counterpartyKind` / `counterpartyId` values,
plus an optional `dueDate`. `JournalEntryCollection.getCounterpartyBalances()`
reports posted AR/AP movements for caller-selected accounts. Aging is an
open-item report: the original line needs a source reference and due date, and
the later settlement uses `settlesSourceRef`; do not infer aging from a net
counterparty balance.

Use `postReceivable`, `postPayable`, or `postSettlement` for exact ledger
events. They take a tenant-scoped idempotency key and create journal plus lines
under the framework's atomic retry claim. A replay with changed content is
refused. Refunds and disputes must post a separate compensating entry with a
new key; posted ledger journals and their lines cannot be edited, deleted, or
voided. Reverse the debit/credit accounts and set `settlesSourceRef` to the
original open item when reducing it. Partial reversals use the partial integer
amount; full reversals use the remaining amount. Commerce/sales owns deciding
that amount and retaining the external payment/refund event, including disputes
after payout; ledgers never initiates a money transfer. Retry the same key after
a crash between external payout completion and ledger posting. A failed ledger
transaction rolls back the journal, lines and retry receipt together. Manual
draft edits and posting claim the parent journal revision in their transaction;
a concurrent loser fails closed and must reload before retrying.

Keys are unique within `(tenantId, ledgerId)` and bind all accounting inputs,
including an explicitly provided date. Omitted dates use the first successful
posting time. Caller references must uniquely identify each open item within the
selected account set. Use `normalBalance: 'credit'` for AP aging/balances (AR is
debit-normal by default). Balance reports use `from`/`to`; aging uses `from`/`asOf`. Choose a `from`
that includes the original obligation. An out-of-order settlement is included
once its source exists; future-dated movements are excluded from historical
reports. Negative balances/credits remain visible in balances, not aging buckets.

Ledger currency, owner and balance mode are immutable. Amounts are safe integer
minor units with zero epsilon; helpers never round, allocate residuals or convert
currency. Sales owns deterministic allocation rounding and residual assignment;
commerce owns original gross/tax/fee amounts. Each boundary must pass reconciled
integers, e.g. a CAD 100.00 worker co-op invoice posts 10000 debit to receivables
and 10000 credit to project revenue. A CAD 40.00 settlement reverses 4000 of that
receivable, leaving 6000. Legacy unassigned journals retain their existing void
and decimal behavior.

The transactional posting and subledger suites cover SQLite and PostgreSQL.
DuckDB cannot provision this package's existing `JournalEntry` cascading foreign
keys: the framework explicitly rejects DuckDB's unsupported ON UPDATE CASCADE.
It is not a supported exact-ledger runtime; no relationship is weakened to make
that dialect appear compatible.

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
   with an STI discriminator) stay. Before writing anything it refuses a row
   whose owner is uncertain, ids already present in `ledger_accounts`, and any
   foreign key into `accounts` that no registered model declares (it would
   otherwise dangle, or cascade); a rerun is a no-op. The same step is
   `migrateLedgerAccountsTable(db)` / `planLedgerAccountsTableMove(db)` from
   this package — call it with the application's models registered, as the
   CLI does.
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

Accounting identities are insert-only on their first save: an explicit slug/context
collision cannot replace an existing ledger, account, journal, or line. Load the
existing object to update it through its lifecycle guards. This also applies to
legacy unassigned objects; natural-key replacement is not a supported update path.
Legacy tenant journals may still use shared global accounts that have no ledger;
scoped journals require accounts owned by their ledger.

A journal chooses its ledger scope at creation. Persisted draft journals cannot
move between ledgers or change between unassigned and scoped, even when empty.
Create a new journal for another scope; this prevents an in-flight legacy line
from entering an exact ledger after its validation. Ordinary same-scope draft
edits and legacy decimal journals retain their existing behavior.
