# @happyvertical/smrt-expenses

Expense records for the s-m-r-t framework: a cost someone incurred, charged to a
job, work package or project, with the receipt that proves it, an explicit
review, reimbursement recording, and drawdown of a purchase-order commitment.

- **Expense** — polymorphic cost object, category, amount in integer minor
  units with currency, incurred date apart from recorded time, who recorded
  it, who paid (the company, a named person, or a named third party), optional
  smrt-commerce vendor and commitment, and a review state.
- **ExpenseReceipt** — expense ↔ smrt-assets `Asset` join with uploader,
  filename, MIME type, byte count and `contentSha256`. The same file twice on
  one expense is refused; the same file on two expenses is reported for a
  person to look at.
- **Commitment drawdown** — reviewed actuals reduce what remains open on a
  smrt-commerce `PurchaseOrder` (or one of its lines), each exactly once.

Out of scope: receipt OCR or parsing, posting to an accounting provider, and
labour (see `@happyvertical/smrt-timesheets`, #3288).

## Install

```bash
pnpm add @happyvertical/smrt-expenses
```

Depends on `@happyvertical/smrt-commerce` (vendors, commitments) and
`@happyvertical/smrt-assets` (receipt files). Profiles are referenced by id
(`@happyvertical/smrt-profiles:Profile`) without a hard dependency.

## Schema

Tables are created by migrations, never at runtime:

```bash
smrt db:migrate          # creates expenses and expense_receipts
smrt db:status --parity  # verifies the live schema matches
```

## Usage

```typescript
import {
  ExpenseCollection,
  ExpenseReceiptCollection,
  computeContentSha256,
} from '@happyvertical/smrt-expenses';
import { withTenant } from '@happyvertical/smrt-tenancy';

await withTenant({ tenantId }, async () => {
  const expenses = await ExpenseCollection.create({ db });
  const expense = await expenses.create({
    costObjectType: '@happyvertical/smrt-projects:Project',
    costObjectId: project.id,
    category: 'material',
    description: 'Framing lumber',
    amount: 100000, // $1,000.00 — integer minor units
    currency: 'USD',
    incurredOn: '2026-09-15',
    recordedByProfileId: recorder.id,
    commitmentId: purchaseOrder.id, // optional; must share the currency
  });
  await expense.save();

  // Receipt: the hash is what makes duplicates detectable.
  const receipts = await ExpenseReceiptCollection.create({ db });
  await receipts.attachReceipt({
    expenseId: expense.id,
    assetId: asset.id,
    contentSha256: computeContentSha256(fileBytes),
    byteCount: fileBytes.byteLength,
    uploadedByProfileId: recorder.id,
  });

  // Review is its own action — gate it in your route (e.g. `expenses.review`).
  await expense.review({ reviewerProfileId: manager.id });

  const position = await expenses.commitmentPosition(purchaseOrder.id);
  // A 4,600.00 award with 1,000.00 reviewed: { drawn: 100000, open: 360000 }
});
```

### Review

Every expense starts `unreviewed`. Only these methods move it:

| Method | From | To |
| --- | --- | --- |
| `review({ reviewerProfileId })` | `unreviewed` | `reviewed` |
| `reject({ reviewerProfileId, reason })` | `unreviewed`, `reviewed` | `rejected` |
| `markDuplicate({ reviewerProfileId, duplicateOfId })` | `unreviewed`, `reviewed` | `rejected` + duplicate marker |
| `reopen({ reviewerProfileId })` | `reviewed`, `rejected` | `unreviewed` |

Writing `reviewStatus` (or the reviewer, time, note or duplicate marker)
directly and saving is refused. A reviewed expense's amount, currency, dates,
cost object, vendor, commitment and payer are frozen until `reopen()`.
Attaching a receipt and recording a reimbursement never change review state.

### Receipts and duplicates

```typescript
// Same file, same expense → DuplicateReceiptError (code EXPENSE_RECEIPT_DUPLICATE)
// Same file, different expenses → allowed, and listed here:
const groups = await receipts.findDuplicateReceipts();
// [{ contentSha256, expenseIds: [a, b], receipts: [...] }]
```

### Money and currencies

Amounts are integer minor units (`$19.99` is `1999`). Totals are per currency
and never summed across currencies:

```typescript
await expenses.totalsByCurrency({ where: { costObjectId: job.id } });
// { USD: { amount: 125000, count: 3 }, CAD: { amount: 4000, count: 1 } }
```

An expense matched to a commitment must be in the commitment's currency; a
mismatch is refused on save.

### Reimbursement

An expense `paidBy: 'person'` with `paidByProfileId` may be `reimbursable`
(owed back). `markReimbursed({ at, reference })` records the payback. Paying
it is payroll's or payables' job (#3292).

## Consumer controls

- **Closed generated surface.** No generated CRUD, read, MCP or CLI
  operation reaches cost data (generated reads check no read permission). List
  expenses through your own permission-checked routes.
- **Generated write actions (#4001).** `ExpenseCollection` publishes four
  service-backed REST actions, each guarded inside the action by its
  `expenses.<action>` permission, with the tenant and acting profile taken
  from the session:

  | Route | Body |
  |---|---|
  | `POST /expenses/record` | expense fields (`amount` minor units, `currency`, `incurredOn`, cost object, payer, …) |
  | `POST /expenses/attachReceipt` | `{ expenseId, assetId, contentSha256, filename?, mimeType?, byteCount? }` |
  | `POST /expenses/recordReview` | `{ expenseId, decision: 'approve' \| 'reject', note?, reason? }` |
  | `POST /expenses/recordReimbursement` | `{ expenseId, reference? }` |

  `recordReview` and `recordReimbursement` refuse super-admin bypass. Acting
  on another person's expense needs `expenses.recordReview`. A recorded
  expense is `unreviewed` (awaiting review); there is no separate submit.
- **Required tenancy.** Tenancy is optional by default, like smrt-commerce.
  To require a tenant context for every read and write:

  ```typescript
  import { registerTenantScopedClass } from '@happyvertical/smrt-tenancy';

  registerTenantScopedClass('@happyvertical/smrt-expenses:Expense', { mode: 'required' });
  registerTenantScopedClass('@happyvertical/smrt-expenses:ExpenseReceipt', { mode: 'required' });
  ```

## Mapping from consumer models

| Donor field | smrt-expenses |
| --- | --- |
| domacraft.com `FinancialCost.kind = actual` | an `Expense` |
| `FinancialCost.kind = commitment` | a smrt-commerce `PurchaseOrder` (`Contract`), with `ContractLineItem` lines |
| `FinancialCost.kind = labour` | `@happyvertical/smrt-timesheets` (#3288), not an expense |
| `FinancialCost.kind = allowance` | out of scope: a planned amount is a budget record, not an incurred cost |
| `FinancialCost.currency`, `amount` (minor units) | `currency`, `amount` |
| `FinancialCost.reviewStatus` | `reviewStatus` + `reviewedByProfileId`, `reviewedAt`, `reviewNote` |
| `FinancialCost` duplicate-review marker | `markDuplicate()` → `duplicateOfId`, `rejected` |
| `FinancialCost.matchedCommitmentId` | `commitmentId` (+ optional `commitmentLineId`) |
| domacraft.com#143 vendor / worker / work package | `vendorId` / `paidByProfileId` / `costObjectType` + `costObjectId` |
| `FinancialCostAsset` (cost, Asset) | `ExpenseReceipt` (`expenseId`, `assetId`) |
| `FinancialCostAsset` uploader, filename, mime, bytes, `contentSha256` | `uploadedByProfileId`, `filename`, `mimeType`, `byteCount`, `contentSha256` |
| `FinancialCostAsset` unique tenant + cost + hash | unique index `(expense_id, content_sha256)` — the expense fixes the tenant, and it also holds for NULL-tenant rows |
| teamworks-os `JobExpense.job` | `costObjectType` + `costObjectId` |
| `JobExpense.category` | `category` (`material`, `consumable`, `outside-service`, `freight`, `other`, …) |
| `JobExpense.description` | `description` |
| `JobExpense.amount` (cents) | `amount` + `currency` (set it explicitly) |
| `JobExpense` incurred date | `incurredOn` (`YYYY-MM-DD`); entry time is `recordedAt` |
| `JobExpense` logged-by | `recordedByProfileId` |

Imported rows start `unreviewed`; replay each donor review through
`review()` / `reject()` / `markDuplicate()` so the transition rules apply.

## Testing

```bash
pnpm --filter @happyvertical/smrt-expenses test           # SQLite + UI SSR
pnpm --filter @happyvertical/smrt-expenses test:postgres  # PostgreSQL lane
pnpm --filter @happyvertical/smrt-expenses test:e2e       # Native browser forms
```

## See also

- [AGENTS.md](./AGENTS.md) — invariants and gotchas for this package
- [smrt-commerce](../commerce/README.md) — vendors and purchase orders
- [smrt-assets](../assets/README.md) — receipt files
- [smrt-tenancy](../tenancy/README.md) — tenant context and required mode

## Expense and receipt UI

`ExpenseForm` and `ExpenseReviewPanel` from `@happyvertical/smrt-expenses/svelte`
provide native purchase entry, caller-driven duplicate/correction review and
Assets receipt composition. `ExpenseForm` uses the shared localized currency
selector while preserving native field names and rejected raw drafts. See
[the UI contract](agents/expense-ui.md) for public props, selector restrictions,
native payloads, retained errors and server responsibilities.


The Svelte export also provides `ExpenseList` for a caller-authorized cost-object
projection, `ExpenseReceiptCapture` for native file upload or shared camera
capture, and `ExpenseReviewQueue` for native approval/rejection with retained
reasons. `ExpenseForm` includes an optional amount keypad and editable
cost-object references. See [the UI contract](agents/expense-ui.md) for public
Props, request identity, no-JavaScript behavior and server responsibilities.

## Optional supplier financial facts

Existing expenses retain only their recorded amount: `getFinancialBreakdown()`
and `getCostBasis()` return `null` until a caller supplies explicit facts. An
empty tax array asserts no tax; absent facts never imply tax-free treatment.

`setFinancialBreakdown({ currency, subtotal, taxes, total })` accepts integer
minor units. Each tax component is `{ code, amount, recoverableAmount }`: its
unique lower-case kebab-case code is caller-defined and its recoverable portion
is explicit, including zero. Subtotal plus taxes must exactly equal both total
and `Expense.amount`, in `Expense.currency`. Components share the total's sign,
recovery cannot exceed charged tax, and all values must be safe integers.
Unknown fields and malformed persisted JSON fail closed. The `financialBreakdown`
text column stores these facts; use the helpers rather than editing JSON.

`getCostBasis()` returns `{ currency, subtotal, taxTotal, recoverableTax,
nonRecoverableTax, total, costBasis }`. Cost basis equals subtotal plus
non-recoverable tax (equivalently total minus recoverable tax), with no rounding.
For example, subtotal 10000, tax 1000 and recoverable tax 400 yield basis 10600.
This is a purchase-cost fact, not a customer markup or sales-tax decision.
Callers select their tax treatment; the package supplies no jurisdiction defaults.

`paidBy: 'third-party'` requires `paidByName`. It excludes `paidByProfileId` and
`reimbursable`; company and person behavior remains unchanged. No reimbursement
or settlement is inferred from the named payer.

Negative amounts require `refundOfId`, naming a positive non-refund expense
visible in the same tenant and currency. Refund breakdown components are negative
(or zero), including recovered tax. Self, missing, foreign-owner, currency-mismatched,
and refund-of-refund sources fail closed. Source lookup uses the caller's database
executor. Every persisted linked refund reserves gross cash capacity, including
unreviewed or rejected rows. Cumulative refunds cannot exceed source gross.
Known financial reversals additionally cannot exceed the source subtotal or any
exact source tax-code component's charged, recoverable, or nonrecoverable amount;
components cannot compensate for one another. Source and refund edits revalidate
the prospective position. Known linked facts cannot be cleared. This records
reversals, not settlement allocation, customer credit authority, or entitlement.

`await expenses.refundPosition(sourceId)` (also `source.getRefundPosition()`)
returns positive `sourceAmount`, `refundedAmount`, and `remainingAmount`, plus
all `refundIds`. Its `financialPosition` contains the original breakdown, signed
negative cumulative `refunded` breakdown, and positive/zero `remaining`
breakdown. It is null if source facts or any refund facts are unknown; unknown
never implies zero tax or completed reversal. Known refunds on unknown legacy
sources remain valid, bounded by known gross. When source facts exist, all known
refund components remain bounded even if another refund's facts are unknown.
The read retains the caller transaction and tenant boundary. Source gross is
preserved: recording refunds never overwrites it.

Expense saves validate and persist in one transaction, including nested caller
transactions. On PostgreSQL, source edits and refund writes acquire ordered
row locks on the expense and proposed source before relationship validation,
keeping the source/refund checks valid through the write and commit. SQLite uses
the framework's serialized write transactions. The existing per-row revision
check still rejects stale object writes; protecting the relationship additionally
requires these locks and the source revision claim below. Callers must not concurrently reuse the same mutable
model instance while it is temporarily transaction-bound. Direct SQL writes
remain outside these model-level guarantees.

Linking a refund, changing its source, or editing its amount/financial facts claims the source revision in
that same transaction through `claimRevision(source.updated_at)`. This makes a
source edit under an older PostgreSQL `REPEATABLE READ` snapshot fail with a
serialization error instead of missing the new refund. Reload a source after
linking a refund before editing/reviewing it; on a serialization failure, retry
the entire caller transaction with fresh instances. Failed outer transactions
roll back both the refund and the source revision claim. Saves that do not change
capacity-relevant fields do not advance the source revision.

Financial breakdown, third-party payer name, and refund provenance join the
existing reviewed-money lock. Save `reopen()` first, then correct facts and review
again; corrections cannot ride alongside the reopen operation. New columns are
additive via `smrt db:migrate`; legacy amounts survive without invented facts.
The SQLite and PostgreSQL suites execute upgrades from the preceding schema and
check that repeat migration is a no-op.

### Refund cash recipients and reimbursement positions

A refund's optional `refundRecipient` is guarded JSON, read/written through
`getRefundRecipient()` / `setRefundRecipient({ kind: 'company' })` or
`setRefundRecipient({ kind: 'person', profileId })` or
`setRefundRecipient({ kind: 'third-party', name })`. A third-party name is exact
retained source evidence (nonblank, at most 200 characters), not independently
verified party/customer identity. It is never trimmed, fuzzily matched or resolved
to another party by this API. It states who actually
received the cash, independently of `paidBy`. Missing recipient is unknown;
historical payer fields are never reinterpreted as receipt evidence. The field
belongs only to linked negative refunds and joins the reviewed-money freeze.

For a positive person-paid reimbursable source,
`await expenses.reimbursementPosition(sourceId)` (or
`source.getReimbursementPosition()`) reports original `sourceAmount`,
`personRefundAmount`, `companyRefundAmount`, retained `reimbursedAmount`,
`remainingAmount`, and separate `owedToCompany`. Company-received refunds do not
reduce the person's original gross cash claim. Same-person refunds do. A later
person-received refund after reimbursement creates money owed to the company;
it never becomes a negative reimbursement or automatically records settlement.
These cash values remain separate from economic `getCostBasis()`.

`markReimbursed({ amount?, at?, reference? })` records only the full known
remaining claim and retains exact `reimbursedAmount`, preserving source gross.
An optional expected `amount` must match it exactly; partial payment is refused.
An existing payment cannot be overwritten, and its cash claim/payer remain
fixed. Payment fields cannot be forged by direct save. Existing no-refund
callers may omit amount and record the full original gross as before.

`unknownReason` identifies an unknown recipient, another person's recipient,
an explicit third-party receipt (`unknown-third-party-recipient`), or a historical
reimbursement marker without retained paid cash. A third-party receipt is never
counted as company/person cash or interpreted as income or settlement. Unknown
positions return null liability/receivable rather than inferring zero or a
historical gross payment. Resolve legacy evidence explicitly; this API supplies
no automatic legacy conversion. Recording is not transfer execution. Both public
position reads and writes preserve caller transaction affinity and source locks;
refund-recipient changes also advance the source revision to reject stale
REPEATABLE READ reimbursement decisions.
