# @happyvertical/smrt-ledgers

Double-entry accounting with chart of accounts, journal lifecycle, and balance enforcement.

## Models

- **Account**: 5 types (asset/liability/equity/revenue/expense). Hierarchical via `parentId`. Debit-normal (asset, expense) vs credit-normal (liability, equity, revenue). Methods: `getAncestors()`, `getFullPath()`, `toTreeNode()`, `getBalance(asOfDate?)`.
- **Journal**: lifecycle `draft → posted → voided`. **Immutable after posting** (can only void, not edit). `sourceModule`/`sourceRef` for cross-package attribution. Auto-numbered (e.g., "JNL-0001").
- **JournalEntry**: debit XOR credit (not both, validated on save). Multi-currency via `exchangeRate`. Non-negative amounts required.

## Balance Enforcement

`journal.post()` validates `Math.abs(totalDebits - totalCredits) < BALANCE_EPSILON` where `BALANCE_EPSILON = 0.01` (float rounding tolerance). Unbalanced journals cannot be posted.

## Gotchas

- **Float tolerance**: 0.01 epsilon for balance check — not exact equality
- **Entry requires journalId**: save Journal first, then add entries
- **Posted journals cannot be modified**: only voided (`voidReason`, `voidedAt`)
- **Account types inherited by children**: child cannot differ from parent type
- **getBalance() is async**: requires JournalEntryCollection query (not stored on Account)
- **Optional tenancy** on all models
