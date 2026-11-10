# Reviewed expense attribution

`ExpenseCollection.reviewAllocation(input, authority)` reviews a **full** split
of a positive, reviewed original. The source keeps its original amount, payer,
commitment, reimbursement, refund capacity, supplier tax facts and receipt graph.
Children are attribution, never additional expenses or another cash authority.

The input names `sourceExpenseId`, the loaded `updated_at` as
`expectedSourceRevision`, `requestId`, `reviewEvidence`, and 1–1000 portions.
Each portion has an exact positive safe-integer `amountMinor`, unique
`portionKey`, registered same-tenant `costObjectType`/`costObjectId`, and explicit
`costCodeRef`. Portions must sum exactly to source gross money in source currency.
No remainder, tax allocation, customer markup or tax policy is inferred.

Ambient `expenses.recordReview` authorizes a person in the active tenant. The
mandatory host `authorizeSource(principal,sourceExpenseId,executor,context)`
callback checks original source privacy for full reviews. Its context names the
explicit review/reserve/bind/release action; billing contexts include only the
bounded authorized portion so target finance users need no unrelated original
project or full receipt disclosure. The mandatory
`authorizeTarget(principal,target,executor)` callback must enforce
current project grants for **every old and proposed target**. The supplied
executor is the command's caller-affine transaction. Callback denial rolls back
all children/head/revision claims. Never perform provider writes in the callback.

A source lock and revision compare-and-swap serialize allocations and billing
reservations. Same request/payload returns the same immutable IDs after current
authority checks; changed payload conflicts. On serialization/revision failure,
retry the whole caller transaction with fresh instances. Unreserved corrections
append a revision linked by `previousRevisionId`; prior children remain readable.
While an allocation is active, source review cannot be reopened/rejected.
Use explicit audited unbilled withdrawal before source correction; immutable
allocation provenance prevents physical source deletion.

`totalsByCurrency()` counts each source once. Target filters project the current
portions instead of counting the source's original attribution. Commitment
positions, supplier-tax reports and reimbursement/refund positions retain the
original accounting source exactly once. `forCostObject()` remains an original
source/evidence query; use target-filtered totals for allocated money. Do not sum
source amounts obtained as evidence to calculate target costs.

`resolveExpenseAllocationPortion(db,portionId,authority)` returns only that
portion's immutable source/revision/fingerprint/target/code/amount/currency and
current `active` flag after project authority; it does not disclose receipt URLs
or other projects. Receipt access still needs the original source privacy check.
`getExpenseAllocationPortionPosition` adds current reservation UUID, host draft
references and bound invoice references/status for that same target portion. It
is advisory; reservation mutations always recheck capacity atomically. Historical
or issued claims never become available implicitly.

## Billing

`reserveExpenseAllocationPortion` reserves a whole portion once against a host
`draftType`/`draftId`, requiring `authority.authorizeDraft`; it can alternatively
reserve and bind directly to an existing invoice/line. Customer price remains
independent of source capacity. `bindExpenseAllocationPortion` assigns that same
reservation UUID to one same-tenant, same-currency commerce draft line after
mandatory `authorizeInvoice` current-grant/project checks. The line must use
`EXPENSE_ALLOCATION_INVOICE_SOURCE` and `sourceId = portionId`.

Commerce stores only the reservation pointer, with trusted source-handler checks
on line mutations and invoice issue. Missing handlers, unbound protected lines,
changed/cleared bound identities, copied pointers and duplicate line claims fail.
All reservation and binding events are immutable relational rows; source locking,
CAS and unique event keys prevent concurrent double assignment. There is no
commerce-side source availability balance.

`releaseExpenseAllocationPortion` records withdrawal and removes a bound draft
pointer in the same transaction. It retains claim/binding history. Active claims
block allocation supersession. Once issued, a claim remains consumed: ordinary
release/reallocation is refused and corrections require an explicit credit or
reversal policy; the API never rewrites issued invoices or infers such policy.

Migrate schemas before use, including the three new allocation tables, nullable
Expense head and nullable commerce line pointer. Existing unsplit rows retain
NULL heads/pointers and unchanged accounting semantics. See the
[behavior matrix](allocation-test-matrix.md) for release evidence requirements.

Bounded readers use the explicitly published `expenses.read` catalog permission
(registered through public `registerPermissionDefinitions`; `get`/`list`
normalize to `.read`) and the host's mandatory current target-cost
visibility callback. They never require review authority or original-source
privacy access. Mutations retain `expenses.recordReview`. Consumers must grant
these real permissions through their role configuration; never fabricate a
permission snapshot to call the library.

Bounded identities include source date, payer **category** (no person/name),
reimbursement eligibility, nullable supplier-tax presence, refund presence and
nullable exact `costBasisMinor`. Basis equals portion gross only when the
original's complete known basis equals gross and no linked refunds exist. It is
otherwise unknown; tax is never apportioned implicitly. New reserve/bind commands
refuse a source with any linked refunds pending explicit reversal policy.
Reimbursement eligibility freezes with allocation provenance. Existing issued
reservations remain consumed and immutable when later refund evidence arrives.

The source fingerprint includes a private random per-source nonce retained only
in full source-authorized revision evidence. Bounded readers receive its digest,
not the nonce, preventing offline guesses of another project's source total.
Unbilled supersession reuses the nonce and retains the same source fingerprint.

## Explicit unbilled withdrawal before source correction

`ExpenseCollection.withdrawAllocation` (root `withdrawExpenseAllocation`) accepts
`sourceExpenseId`, `expectedActiveRevisionId`, `expectedSourceRevision`,
`requestId` and `reviewEvidence`. It appends an immutable revision with
`kind: 'withdrawal'` and clears the active head atomically on the caller executor.
The result is `{revision, withdrawnRevisionId}`; reload the original source for
its current state/revision. No portion row is changed or deleted.

Withdrawal requires current source privacy/edit authority with action
`withdrawAllocation`, authority for **every old portion target**, and a separate
mandatory `authorizeUnsplitTarget(principal,{sourceExpenseId,costObjectType,
costObjectId},executor)` callback for the restored original destination. The
latter has no invented cost code. Assigned destinations must exist in the active
tenant; an explicitly unassigned original has both destination strings empty and
still requires the callback. Replays reauthorize all of these paths; changed
payload, stale source/head or a conflicting request is refused.

Any active reservation, bound claim or issued claim refuses withdrawal. First
abandon/release an authorized unissued draft explicitly; withdrawal never
silently releases capacity or rewrites issued invoices. **This is not billed
reversal support.** Existing settlement/refund/reimbursement guards also remain.

Global and commitment totals still count the original source once. Its monetary
attribution switches atomically back to the original unsplit destination. Source
review status is unchanged: no financial approval is implied. The caller may
then explicitly reopen and correct the original amount/date/payer or reject a
duplicate using existing guarded source methods. Corrected unreviewed money stays
excluded until separately reviewed. Original receipt evidence remains immutable
once allocation history exists, including after withdrawal.

The immutable predecessor chain has one successor per revision. Its unique leaf
retains the latest withdrawal independently of a null active head; the next
review links to that withdrawal deterministically. Typed source snapshot facts
on each revision preserve historical portion date/payer/basis attestation across
later source correction. Inactive historical portions remain bounded-readable
with `active:false` when the source is reopened/rejected; they are never available
for fresh billing. Active portions still require a usable reviewed source.
