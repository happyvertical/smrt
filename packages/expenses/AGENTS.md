# @happyvertical/smrt-expenses

Incurred costs against a cost object, with deduplicated receipts, an explicit
review, reimbursement recording, and smrt-commerce commitment drawdown (#3289).

## Models

- **Expense** (`expenses`): `costObjectType` (qualified class name) +
  `costObjectId` (bare string), `category` (lowercase kebab-case; suggestions
  in `SUGGESTED_EXPENSE_CATEGORIES`), `amount` integer minor units + ISO 4217
  `currency`, `incurredOn` (`YYYY-MM-DD` text: a calendar date, not an
  instant), `recordedAt`, `recordedByProfileId`, `paidBy` (`company` |
  `person`) + `paidByProfileId`, `vendorId`, `commitmentId` /
  `commitmentLineId`, review fields, `reimbursable` / `reimbursedAt` /
  `reimbursementReference`.
- **ExpenseReceipt** (`expense_receipts`): noun-specific asset join
  (`expenseId` → Expense, `assetId` → smrt-assets Asset) with uploader,
  `filename`, `mimeType`, `byteCount`, `contentSha256`. Collection extends
  `SmrtJunction` (left expense, right asset, ordered by `created_at`).

## Invariants

- **Review is method-only.** `review()`, `reject()`, `markDuplicate()`,
  `reopen()` read the persisted status, check the move, and authorize exactly
  one save through a module `WeakMap`. Every transition assigns every review
  field, and the token carries that complete resulting state, so a field set
  directly beside `review()`/`reject()` (e.g. an injected `duplicateOfId`)
  is refused. A `reviewed` expense never carries `duplicateOfId`. `save()` compares every review field
  (status, reviewer, time, note, `duplicateOfId`) with the stored row and
  refuses an unauthorized change (`EXPENSE_REVIEW_FIELDS_LOCKED`), including
  on a brand-new row. Review fields are also `readonly` for generated writes.
- **Writes are pinned to the guarded row.** The guards read the row stored
  under `id`, but core's natural-key save adopts any same-owner row on
  `(tenant_id, slug, context)` and upserts it with no revision predicate;
  these models' slugs come from the id. So `pinNaturalKey()` lets a fresh
  (not `isPersisted`) instance only INSERT (`requireInsertOnSave()`): naming
  an existing row's id is `EXPENSE_IDENTITY_CONFLICT`, and a row appearing
  mid-save fails the INSERT instead of being adopted. An existing row changes
  only through a loaded instance (revision compare-and-swap) that keeps its
  slug/context. Never `create({ id: <existing> })` or `getOrUpsert()` these
  models; load and save instead.
- **Reviewed money is frozen.** While the stored status is `reviewed`,
  `LOCKED_WHEN_REVIEWED` fields (money, currency, both dates, cost object,
  vendor, commitment, payer) cannot change; `reopen()` first. `recordedAt` is
  compared as an instant, since drivers return it as a `Date` or a string.
- **Drawdown counts once.** `ExpenseCollection.commitmentPosition()` sums only
  `reviewed` rows with no `duplicateOfId`, in the commitment's currency, deduped
  by id. Committed is the contract's `totalAmount` (or the line's `amount`).
- **Currencies never mix.** A commitment match must share the currency and
  tenant (`EXPENSE_COMMITMENT_MISMATCH`), checked when the match, line or
  currency is set or changed — not on every save, so a later commitment edit
  never blocks e.g. `markReimbursed()`. `totalsByCurrency()` keys by currency.
  Rows left in another currency by a later commitment change land in
  `otherCurrencies`, never in `drawn`.
- **Duplicate receipts.** Same `(expense, sha256)` is refused by a pre-insert
  read plus the unique index `expense_receipts_expense_sha256_key`
  `(expense_id, content_sha256)`; a unique violation is rethrown as
  `DuplicateReceiptError`, classified from the error itself (violated key
  name, or `details.fieldName` columns on core's typed error) because on
  PostgreSQL the violation aborts a caller's transaction and nothing can be
  re-read; only an error naming no key falls back to a re-read. The index omits `tenant_id` deliberately: the
  expense already fixes the tenant, and a nullable leading `tenant_id` would
  leave NULL-tenant (global) receipts unenforced. Same hash on different
  expenses is allowed; `findDuplicateReceipts()` reports it (facet on
  `contentSha256`, count > 1). Receipt `tenantId` (derived from the
  expense on insert), `expenseId`, `assetId` and `contentSha256` are
  immutable. The inherited `SmrtJunction.attach()` and
  `setLinks()` are overridden to throw (`setLinks()` would delete every
  receipt, then fail to re-attach without hashes); `attachReceipt()` adds and
  `detach()` removes a link, keeping the asset. Because `ExpenseReceipt`
  overrides `save()`, `hasBaseJunctionLifecycle()` is false and no batch
  junction path can write a hashless row around it.
- **Vendor ownership.** `vendorId` is a `crossPackageRef` (no FK, no
  validation), so `assertVendor()` checks the vendor is visible in and owned
  by the expense's tenant whenever it is set or changed
  (`EXPENSE_VENDOR_MISMATCH`).
- **Tenant never moves.** Expense and receipt tenants are fixed once
  stored, compared as `effectiveTenant()` (the field, or the active context
  the `beforeSave` interceptor would fill an unset one from; unset is falsy,
  so `''` counts). `normalizeTenantId()` stores `''` as NULL (global), never
  as a pseudo-tenant, matching core/tenancy's falsy "unset". Otherwise a
  global (NULL-tenant) row saved inside `withTenant()` would be silently
  populated and split from its global expense or receipts.
- **Tenancy.** Optional (`@TenantScoped({ mode: 'optional' })`, nullable
  `tenantId`), like smrt-commerce. A receipt takes its expense's tenant; its
  expense and asset must be visible in that tenant. A commitment must belong
  to the expense's tenant; before `super.save()` that is
  `tenantId ?? getTenantId()`, because the interceptor has not populated it.
  Consumers make it required with a qualified
  `registerTenantScopedClass(…, { mode: 'required' })`.
- **Closed generated surface.** Models AND collections declare
  `api: { include: [] }`, `mcp: { include: [] }`, `cli: false`. Collection
  classes are registered too: an undecorated collection publishes its CRUD and
  public methods as MCP tools. Core has no consumer-side switch to reopen a
  package model's surface; consumers write their own routes.
- **Cost object is not dereferenced on save.** `getCostObject()` resolves it
  through the registry and returns `null` for a foreign-tenant row. One cost
  object per expense (columns, not a `SmrtPolymorphicAssociation` join) so a
  cost can never roll up into two jobs.

## Cross-package references

- `vendorId` → `@crossPackageRef('@happyvertical/smrt-commerce:Vendor')`
- `commitmentId` → `…smrt-commerce:Contract` (usually a `PurchaseOrder`)
- `commitmentLineId` → `…smrt-commerce:ContractLineItem`
- `assetId` → `…smrt-assets:Asset`
- profile ids → `…smrt-profiles:Profile` (no dependency; references only)
- `expenseId`, `duplicateOfId` → `@foreignKey` within the package

## Scope

Allowance (a planned amount) is not an expense kind; it belongs with
budget/commitment records. Labour belongs to `@happyvertical/smrt-timesheets`
(#3288). No OCR, no accounting-provider posting.

## Validation

```bash
pnpm --filter @happyvertical/smrt-expenses test
pnpm --filter @happyvertical/smrt-expenses typecheck
pnpm --filter @happyvertical/smrt-expenses test:postgres
```

`src/__tests__/helpers/expense-suite.ts` is the shared behaviour suite: the
SQLite file and the PostgreSQL lane (`*.optional.test.ts`, schema from
`migrateSmrtSchemas` plus live parity) both run it. Use UUID tenant and
profile ids in tests: PostgreSQL stores them as `uuid`.

## UI

`src/svelte/` owns native expense entry and review presentation. See
[the UI contract](agents/expense-ui.md) for DTOs, native payloads and recovery.
Draft amounts are lossless currency-unit text; model/review amounts remain integer
minor units. Receipt upload is composed from Assets, never reimplemented here.
`test` includes backend and UI SSR; `test:e2e` proves native browser submissions.
