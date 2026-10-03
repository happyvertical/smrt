# @happyvertical/smrt-expenses

Expense records for the s-m-r-t framework: a cost someone incurred, charged to a
job, work package or project, with the receipt that proves it, an explicit
review, reimbursement recording, and drawdown of a purchase-order commitment.

- **Expense** — polymorphic cost object, category, amount in integer minor
  units with currency, incurred date apart from recorded time, who recorded
  it, who paid (the company or a named person out of pocket), optional
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

- **Closed generated surface.** Models and collections ship with
  `api: { include: [] }`, `mcp: { include: [] }`, `cli: false`: no generated
  REST, SvelteKit, MCP or CLI operation reaches cost data. Expose expenses
  through your own permission-checked routes.
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
Assets receipt composition. See [the UI contract](agents/expense-ui.md) for
public props, native payloads, retained errors and server responsibilities.
