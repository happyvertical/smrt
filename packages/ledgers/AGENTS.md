# @happyvertical/smrt-ledgers

Double-entry accounting with chart of accounts, journal lifecycle, and balance enforcement.

## Models

- **Account**: 5 types (asset/liability/equity/revenue/expense). Hierarchical via `parentId`. Debit-normal (asset, expense) vs credit-normal (liability, equity, revenue). Methods: `getAncestors()`, `getFullPath()`, `toTreeNode()`, `getBalance(asOfDate?)`.
- **Journal**: lifecycle `draft → posted → voided`. **Immutable after posting** (can only void, not edit). `sourceModule`/`sourceRef` for cross-package attribution. Auto-numbered (e.g., "JNL-0001"). `summarize()` is AI-powered via the smrt-prompts registry (see Prompt Registry below).
- **JournalEntry**: debit XOR credit (not both, validated on save). Multi-currency via `exchangeRate`. Non-negative amounts required.

## Key Methods

- **`Journal.summarize()`**: Generates a natural-language summary via the registered `smrtLedgers.journal.summarize` prompt, resolved through `@happyvertical/smrt-prompts`. Tenants can override the template, model, temperature, or other params via `_smrt_prompt_overrides` without code changes. Only non-PII fields (number, date, description, status, aggregate total, entry count, balanced flag) reach the AI provider.

## Prompt Registry

Registered at module-load time via `definePrompt()` in `src/prompts.ts`. Side-effect imported from `src/index.ts` so consumers automatically see the prompts after importing any export from this package.

| Key | Method | Variables |
|-----|--------|-----------|
| `smrtLedgers.journal.summarize` | `Journal.summarize()` | `journalNumber`, `journalDate`, `journalDescription`, `journalStatus`, `journalTotal`, `entryCount`, `journalBalanced` |

PII-conscious variable selection: `tenantId`, `sourceRef` (may reference customer/vendor identifiers), per-entry `accountId`/`id`, and the extensible `metadata` blob are intentionally NOT exposed as prompt variables. Tenants who need richer context should override the template via `PromptOverride` and supply their own variables through a custom call site.

## Balance Enforcement

`journal.post()` validates `Math.abs(totalDebits - totalCredits) < BALANCE_EPSILON` where `BALANCE_EPSILON = 0.01` (float rounding tolerance). Unbalanced journals cannot be posted.

**This package is unit-agnostic** — `debit` / `credit` are plain DECIMAL numbers and the balance check only compares the two sides, so it holds for whatever unit the posting module uses. As of #2401, journals posted from `@happyvertical/smrt-commerce` (`Payment.recordPayment()`, `Invoice.recognizeRevenue()`) carry **integer minor units**, which balance exactly rather than merely within the epsilon. A consumer mixing modules that post in different units will get arithmetically balanced but semantically meaningless journals; pick one unit per ledger.

## Gotchas

- **Float tolerance**: 0.01 epsilon for balance check — not exact equality
- **Entry requires journalId**: save Journal first, then add entries
- **Posted journals cannot be modified**: only voided (`voidReason`, `voidedAt`)
- **Account types inherited by children**: child cannot differ from parent type
- **getBalance() is async**: requires JournalEntryCollection query (not stored on Account)
- **Optional tenancy** on all models
