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

Currency uses the shared `CurrencySelect`, localized by the active smrt-ui i18n
context. It preserves the exact retained draft string and the field name from
`fields.currency`, including native no-JavaScript correction flows. Pass
`currencyOptions` only when the caller must restrict the shared currency catalog.

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

`visibleFields` optionally limits the logical `ExpenseDraftValues` fields rendered by `ExpenseForm`. Omitted renders all existing fields; an empty array renders none. Excluded fields do not emit hidden fallbacks, including `correctionReason`; fixed values can be supplied explicitly through `hiddenFields` without duplicate names. This supports policy-fixed payer fields and domain-owned reference selectors. Visibility is presentation, never authority: endpoints must validate every fixed or submitted value. Unknown retained values and validation errors remain visible for included fields.

Composition validation: native Svelte SSR contracts cover defaults, omitted fields, retained malformed values, caller identity, no duplicate fixed inputs, correction/read-only/pending behavior. No persistence, transaction, tenant authority or external provider changes occur; those matrix dimensions are N/A for this presentation-only extension. Node26/Svelte5 native POST markup is the supported runtime edge.

## Cost-object lifecycle (#3462)

The existing #3423/#3429 entry and review controls are extended with
`ExpenseList`, `ExpenseReceiptCapture` and `ExpenseReviewQueue` in the same
`./svelte` export. Their registry slots are `expense-list`,
`expense-receipt-capture` and `expense-review-queue`; named Props and row types
are public. The playground composes these with the existing controls.

`ExpenseForm` defaults to an optional touch keypad beside amount entry. It is
available after hydration, with ordinary text/keyboard entry and native POST
available without JavaScript. `amountKeypad=false` hides it. Digits, decimal and
backspace edit the exact currency-unit string at its selection; no parsing or
rounding occurs. The server validates currency precision and safe minor units.
`costObject={{ type, id }}` enables two editable native reference inputs, with
`costObjectFields` name adapters and `costObjectErrors` retained server errors.
Omit it when references are fixed in `hiddenFields` (the existing consumer
contract). Do not supply the same reference both ways. Qualified type and bare
id are caller strings and must be validated/authorized by the endpoint.

`ExpenseList` takes caller-authorized `ExpenseListItem[]` plus exact
`costObjectType`/`costObjectId`; both keys must match. It displays each amount
in its own currency, never sums different currencies, and retains unknown
`statusLabel`, optional `note`, authorized `href`, empty and load-error states.
Filtering is presentation only: do not pass unauthorized rows to the browser.

`ExpenseReceiptCapture` is a separate multipart POST action, with
`canAttach=false` by default. `fileField` defaults to `receipt`, submitter to
`intent=attach-receipt`. It forwards `hiddenFields` exactly, including the
expense and caller-owned request tokens. A native file picker works without
JavaScript; “Use camera” mounts the existing smrt-ui `CameraCapture` only after
an explicit click. Capture/retake/commit and stream cleanup are owned by that
shared component. Toggle back to file selection to recover from camera denial
or unsupported APIs. Switching modes discards the previous file; selection is
never uploaded automatically. Pending prevents another upload or mode change;
a committed camera photo remains held for retry. Navigation cannot restore
file inputs: select the file again after a failed upload or page reload. The
server authenticates, validates file content/limits and expense visibility,
stores the Asset and uses `ExpenseReceiptCollection.attachReceipt()` with its
duplicate guard; this component performs no storage, deduplication or model
mutation. Do not place this component inside another form.

`ExpenseReviewQueue` takes authorized `ExpenseReviewQueueItem[]` in caller order.
Decisions require both queue `canReview=true`, row `canReview=true`, and a row
`action` (empty string explicitly means this page). Each row posts its own
`expenseId`, retained `reason`, hidden request context and clicked
`intent=approve|reject`. Field and intent names are configurable. Rejection
requires a reason in native browser validation; approval bypasses that browser
requirement. The server must enforce the reason and reauthorize/reload before
calling `review()` or `reject()`; these UI gates provide no authority. Return
row `reason`, `message` and original request tokens after rejection or an
uncertain outcome. Pending disables decisions. No action is inferred from
status, no submitted row is removed optimistically, and no request key rotates.
Avoid collisions between hidden field names and component identity/reason/intent
fields. Empty, read-only, unknown status and load-error states remain visible.

Lifecycle evidence is in the maintained `test:ui` SSR contracts and `test:e2e`
Chromium proofs: 390px keypad, exact cost-object payload, native multipart file
selection with and without JavaScript, camera denial recovery, and native queue
approve/reject with retained reason and row request identity. Persistence,
transaction affinity and tenant authorization remain existing server contracts;
no database/model surface is changed by these presentation components.
