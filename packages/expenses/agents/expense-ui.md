# Expense entry and receipt review

Import `ExpenseForm`, `ExpenseReviewPanel` and their named Props types from
`@happyvertical/smrt-expenses/svelte`. Registry slots are `expense-form` and
`expense-review`. `@happyvertical/smrt-expenses/ui` exposes metadata without
Svelte; `./playground` exposes an interactive retained-draft/review example.

`ExpenseDraftValues` is a complete set of native strings: `amount`, `currency`,
`incurredOn`, `description`, `category`, `vendorId`, `commitmentId`, `paidBy`,
`paidByProfileId`, and `correctionReason`. Initialize unused fields to `''`.
Amount is ordinary currency text (`'125.00'` CAD), distinct from the public
Expense model's integer minor-unit `amount` (`12500`). Server adapters parse
currency precision, safe integer range and business rules. Calendar dates stay
lossless text, normally `YYYY-MM-DD`; invalid amounts/dates never disappear due
to browser number/date coercion. Every validation failure returns original
strings, not reconstructed saved-model values.

```svelte
<script lang="ts">
  import { ExpenseForm, ExpenseReviewPanel } from '@happyvertical/smrt-expenses/svelte';
  let { data, form } = $props();
</script>
<ExpenseForm
  action="?/save"
  title="Record purchase"
  values={form?.values ?? data.values}
  errors={form?.errors}
  message={form?.message}
  canEdit={data.mayEdit}
  correcting={data.correcting}
  vendors={data.authorizedVendors}
  commitments={data.authorizedCommitments}
  hiddenFields={[
    { name: 'requestId', value: form?.requestId ?? data.requestId },
    { name: 'costObjectId', value: data.costObjectId },
    { name: 'expectedTenantId', value: data.tenantId },
  ]}
/>
<ExpenseReviewPanel
  expense={data.expenseSummary}
  duplicates={data.authorizedDuplicateCandidates}
  history={data.history}
  receipts={data.receiptPanel}
/>
```

Vendor and commitment options are authorized Commerce `{id, label}` projections.
Resolve Profile names and application-specific award lineage in the consumer.
Unknown retained references remain selectable/postable; selecting a reference
never establishes tenant ownership or commitment eligibility. `fields` maps
logical keys to native names; `errors` always uses logical keys. Submitter
`intentField`/`intent` default to `intent=save`. `hiddenFields` preserves exact
values and repeated names. Avoid field-name collisions. `children` adds
application-owned package allocation, quantity, reimbursement and correction
policy fields. `correcting` shows a retained reason, but does not implement a
new Expense correction model. The caller applies its own correction/history
policy and invokes existing guarded methods where appropriate.

The base form performs native POST by default, with or without JavaScript.
`onsubmit` allows optional enhancement. `pending` or a supplied
`smrt-ui/form-retry` `retryStatus` controls progress presentation without clearing
values or creating/rotating request keys. `canEdit=false` disables fields and
hides save; server-side authorization and replay enforcement remain mandatory.

`ExpenseReviewSummary` projects public Expense description, integer minor-unit
amount, currency and incurredOn, with caller-localized `statusLabel` and `note`.
`duplicates` and `history` are explicit authorized presentation DTOs, not a
parallel ledger. The server supplies findings from ExpenseReceipt duplicate
queries and application history. Unknown labels render verbatim. No state or
action is inferred: `canReview`, `action`, `actions` and hidden fingerprints
explicitly provide a native review form. `action=""` posts to the current page;
omitting `action` hides the review form; `children` can supply retained reason
or duplicate-selection inputs. A server must reauthorize, reload the model and
invoke `review()`, `reject()`, `markDuplicate()` or `reopen()` under its policy.
Never assign review fields through UI payload binding. Reviewed money remains
frozen by the existing model; UI props cannot bypass it.

`receipts` is exactly the public Assets `AttachmentPanelProps`, supporting
private view/download URLs, version notes, native upload and recovery. It is
rendered outside the review form so upload and review remain separate native
actions. Use authorized receipt projections; attaching a file does not review
an expense, mark a duplicate, or change invoice approval. Assets owns file
selection and reselect-file help; Expenses does not duplicate uploads/storage.

Validation: `pnpm --filter @happyvertical/smrt-expenses test`, `test:ui`,
`test:e2e`, `typecheck`, `build`, and `verify:pack`. PostgreSQL model validation
remains in the existing opt-in `test:postgres` lane; this UI does not alter it.
