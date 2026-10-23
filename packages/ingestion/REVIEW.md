# Authenticated review surfaces

`@happyvertical/smrt-ingestion/svelte` exports `IntakeInbox`, `IntakeReview` and
`EvidenceViewer`. The browser-safe DTO entry exports their `IntakeReviewHost`
callback contract. Import styling/theme configuration from smrt-ui in the host.
Components use smrt-ui primitives and the `ingestion.*` i18n catalog.

The host authenticates every request, resolves tenant/actor/confidential scope
from its session, enforces CSRF on mutations, and constructs `IngestionService`.
Never accept scope, reviewer, permissions or a principal from callback JSON.
Only supply authorized evidence URLs and escaped text; original URLs are
same-origin authenticated handlers that recheck `readEvidence` on every read.
Candidate discovery uses `findCandidates` with current grants. Presentation
state and disabled buttons provide no server authority.

`listReviews(itemId, {cursor?,limit?})` reloads saved action identities and their
current plan membership without browser storage. It returns at most 50 actions,
with an opaque action-ID cursor. Every payload requires current item, handler,
parent plan and target access under the owning transaction. Denied reads fail
closed. Target reads check current authorization separately from historical
revision freshness: unfinished drift returns state-only stale reviews without
removing unrelated entries; succeeded results remain readable after authorized
target changes. Apply still enforces exact bound target revisions. Expired entries
contain only review identity/state. Stale entries never disclose old args or target
labels; an authorized parent plan additionally exposes `stalePlan` identity, key,
current plan revision and handler identity. Hosts must collect fresh explicit args
from the reviewer/current authorized evidence and call `previewPlan` with that
exact plan CAS and the current completed analysis attempt. Action revision is not
plan revision. Re-expansion preserves action identity and requires fresh approval.
Success results are rechecked through the durable result reader.
Plan membership contains the exact parent args/version so edits call
`previewPlan`, not per-step correction. An item may have more review pages; the
host must aggregate state across pages when projecting a production inbox state.

The host's `load` callback supplies a current `ItemReviewView`, using
`getCompletedAnalysis` with no historical fallback. Generated suggestions bind
the **current generation attempt**, not `generation.source.attemptId` (the prior
extraction). `previewGeneratedProposals` publishes exact reviews and continues to reject stale
generation candidate pins. When `listReviews` reports `generationStale`, the host
omits obsolete generation output and renders authorized saved reviews/results.
Completed saved actions do not hide healthy unprepared suggestions. The saved-binding hint is not
an authoritative generation-availability check: a fresh human preview can bind a
current target while the immutable generation still pins its former revision.
`getCompletedAnalysis` remains strict and throws server-only
`GenerationSnapshotStaleError` only after every current catalog/provider/candidate
read is authorized and an immutable candidate revision differs. The maintained
host catches only that class, reacquires `listReviews` under current owning
authority, and returns that new page without generation output. It never reuses
the earlier page after an error. Denials and unknown failures propagate; healthy
generation still exposes unprepared sibling suggestions. Stale entries expose handler
and attempt identity only when that attempt is still the current completed/partial
analysis. An empty-args editor submits fresh explicit human arguments through
`previewProposal` or `previewPlan` with the saved CAS; it never reuses old generated
arguments, rewrites the generation snapshot or transfers approval. Analysis-stale
entries without an attempt require normal reprocessing. Approve,
reject, defer and correct call `submitDecision`; corrected args create a new
revision which requires a separate human approval. After an approve/defer/reject
decision, optional `editAction` calls `previewProposal` with the current action
revision to publish a new review; completed/executing/unknown actions cannot be
revised. Local dirty args disable Apply but confer no authority. Plan edits re-expand through
`previewPlan` with the current **plan** revision. `applyAction` accepts only an
action ID. Unknown external outcomes require server reconciliation; the UI
never offers a blind resend. Stable result IDs survive reload and retry.

Replace `contextKey` whenever authenticated tenant/session context changes.
Changing it or itemId destroys the old view and fences late callback results.
Denied refresh clears prior originals, candidates, arguments and results.
Missing confidence is unavailable; page/time links exist only for observed
locations. Provider errors and unresolved/partial results remain review states.

## Assignment and logical splits

Assignment is explicitly host-owned, durable and versioned. `assign` receives
an expected assignment version and request ID; the host must authorize the
manager, constrain eligible assignees, CAS the durable record and reject stale
writes. Assignment does not grant read, review or execution rights. The maintained
fixture provisions its own SQLite assignment table before serving requests; no
production ingestion table or migration is introduced for assignment.

`reviseLogicalSplit` authorizes the current generation through the same-executor
catalog/candidate gate and the existing reviewer grant and policy reviewer list.
Process access alone cannot mint or replay a human correction; reviewer authority
is checked before mutation and again before publication. A generation without a
reviewable catalogue cannot be corrected through this reviewer API.
It requires all observed pages exactly once, an exact
current attempt/revision and a request ID. It records the authenticated actor
and predecessor as a **human correction** in a new immutable extraction
configuration, queues re-extraction and immediately makes previous suggestions
and approvals stale. It never changes original bytes/evidence or labels a human
edit as model output. The host processes the new extraction, then calls
`prepareGeneration` and the normal fenced interpretation stage. The supported
immediate-predecessor extraction pin is unchanged. The generator receives a
human correction only after its digest matches the authoritative source. Ordinary
`analyze` calls cannot mint an extraction correction; the owning split API is the
authenticated origin, and forged interpretation corrections fail before provider
disclosure. If its proposed grouping differs from the correction, suggestions are withheld
with `human_split_not_respected`. New proposals require new explicit review.
The reference host runs these stages synchronously for browser determinism;
production hosts dispatch the existing durable analysis jobs.

`feedback` is an optional explicit correctness callback, separate from approval
choice and execution success. No learning, feedback storage or rule promotion is
implemented by these components; #3676 owns those services. Do not pass feedback
or a feedback callback to readers without the relevant host grant.

## Maintained browser proof

`pnpm test:components` runs real Svelte component tests; `pnpm test:e2e` runs the
package-local authenticated Vite application under Chromium. The fixture uses
HttpOnly same-site sessions, CSRF, real SQLite/assets/ingestion/content APIs,
production unpdf child extraction and a deterministic proposal generator. Its
hardcoded test login is fixture-only and is never a production auth provider.
Image/audio originals remain inspectable when no OCR/speech provider is
configured; the suite makes no recognition-quality claim and spends no provider
budget. `reference/review-host.ts` is a maintained development fixture, not a
published server entry. Browser tests show actual approved args and persisted
ContentDocument results, stale tabs, reload, retries and negative access.

Run full package `test`, `test:postgres`, `test:providers`, `build`, `typecheck`,
`test:components`, `test:e2e`; use the root Node/pnpm versions. Set a short
`CI_TEST_TMPDIR`/`TMPDIR`, and optionally
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to the supported installed Chromium.
`pnpm test:evaluation` checks repository evaluation tooling contracts; measured
held-out quality remains a separate frozen-protocol, budget-gated #3677 run.

The existing CI browser job includes ingestion changes and shared UI primitive
changes in affected mode, and runs the ingestion browser suite in full mode. Its
normal dependency build precedes the suite and failed runs upload browser evidence.

The maintained host derives inbox state by traversing bounded public review pages,
authorizing every action/parent/target before classification. It retains only
scalar totals and the requested page; an off-page denial denies the whole view.
The component's Load more and subsequent refresh/mutation reload every displayed
page using fresh cursors, then publish the combined authorized set together. Old
page payloads are cleared while loading; any unavailable page clears all payloads.
This keeps plan controls and earlier steps visible across page boundaries without
reusing a prior authorization decision.

## Published server adapter

Import `createIntakeReviewHost` and `IntakeReviewHostOptions` from
`@happyvertical/smrt-ingestion/server`. Call `createIntakeReviewHost(service,
options)` with a service constructed from the current authenticated session.
The returned `IntakeReviewHost` implements inbox state projection across saved
review pages, current generation loading, stable `ui:<index>` intention keys,
action/plan preview CAS lookup, decisions, apply, corrections, candidates, split
and feedback. Repeated preparation of an unchanged authorized suggestion retains
its current review instead of creating a new revision. Changed arguments still
require explicit re-preview and a fresh human decision.
`list({ state?, assigneeId?, cursor?, limit? })` returns one page newest receipt
first (`intake_items.created_at`, id tiebreak) through `service.listItemsPage`.
`limit` defaults to 20 and is capped at 100; the cursor is an opaque
(received-at, id) continuation, never a bare id. Tenant, confidential scope,
retention and the `state` filter run inside the page query, so a page is full
and `nextCursor` is present only when more rows follow.

Authority is rechecked at the same two levels `load` applies, but per page
rather than per row: the host authorize callback once per distinct captured
ceiling in a batch, and the execution read gate (policy, ceiling, handler and
operation allowlists, principal) once per distinct (item, handler) bound by
the page's saved actions. The list gate is read-only: it evaluates the same
checks as `listReviews` without the retention write, so an item that the item
view would narrow past its deadline is simply not listed. The list gate also
resolves each bound handler and rejects version drift against the saved
binding and omits a cancelled item, as `listReviews` does; it does not
evaluate per-action target,
evidence or plan gates, so an item whose target became unreadable still lists
and its item view refuses. An item whose bound
handler the actor cannot currently read is not listed at all, rather than
listed with a state derived from actions the actor may not see; actions
without a proposal bind no handler and are not gated, as in `listReviews`.
Handler bindings (handler id and version, projected in SQL, distinct per
item) are read once per fetched batch for the rows that passed the item-level
gate. Note the host cost plainly: the execution `authorize` callback runs once
per distinct (item, handler) bound by a scanned row that passed the item-level
gate. Each item is its own authorization subject, so nothing is deduplicated
across items; the count is bounded by rows scanned (at most
`ITEM_SCAN_CEILING`) and runs in host code rather than as N+1 database reads. Either host callback, the item-level `authorize` or the execution
`authorize` behind the handler gate, follows the same rule: a refusal (false,
or an access check that fails) hides the rows it covers, and a callback that
throws rejects the whole page (and `listItems()`) with its error, as `load`
does, so a transient failure never lets paging move past readable rows.
Denied or unreadable rows are skipped without
disclosure and the page refills from the next rows; refills grow from the page
size to 100 rows per query, so a fully denied scope costs about a dozen page
reads and as many binding reads per call. One service call examines at most
`ITEM_SCAN_CEILING` (1000) rows, or the caller's smaller `scanLimit`, and
reports the count as `scanned`; when a mostly-denied scope reaches the ceiling
the page comes back short with a `nextCursor`. Rows are authorized first and
the `state` filter is then applied to the fetched batch, so it is bounded by
the same scan limit: a rare state yields short pages with a cursor rather than
an unbounded walk inside one query. A row the actor can read whose state does
not match discloses nothing and may anchor the cursor, so a filter with no
match among the next 1000 rows returns an empty page with a cursor and still
pages to the end. The host `list` passes its remaining budget as `scanLimit`, so the
rows scanned across the service calls of one host call never exceed 1000: a
short service page with a cursor, or an exhausted budget while filtering by
assignee, ends the host call with the same cursor and the caller continues.
Only rows the service wrote are supported: cursors carry the canonical
millisecond ISO receipt time the service stores. A row whose stored receipt
time is not that form (on SQLite anything but `YYYY-MM-DDTHH:MM:SS.mmmZ`,
including a parseable value without milliseconds or with an offset; on
PostgreSQL a value with a sub-millisecond part) is never listed, whatever the
actor's access, and counts toward the scan, as does a row whose id is not a
UUID. On SQLite a non-text stored value (an integer, say) and a receipt value
or id longer than 64 characters or containing a NUL character are excluded by
the page query itself: the first sorts after every text value so the scan
could never move past it, the second could not be carried by any cursor, and
the third is returned truncated at the NUL, so it would look canonical and
sort above a legitimate row at the truncated value. Within a call the scan moves
past a service-foreign row by its exact stored value, and an unsealed cursor
names the last row before it that the actor can read. A call that finds no readable row within its scan limit (at
most 1000) fails closed with `IntakeScanLimitError` unless a `cursorKey` is
configured, as below. The host
`list` returns what earlier service calls collected, with their cursor, when
a later call fails that way.

`listItems()` is deprecated and kept only for callers of the array-returning
API. It walks every page, so its cost grows with the scope, including one
execution authorization per (item, handler) across the whole scope. It follows
the internal scan position, which never leaves the service, so runs of rows
the actor cannot read never stop it and it returns `[]` where nothing is
readable. Items are newest-first and gated exactly as on a page.

The page's inbox state is the durable projection of the saved action journal
and processing state, computed once per scanned row inside the page query;
`load` remains the authoritative, live-gated projection for one item (it still
projects individual stale actions, which the list does not). Cost is
proportional to the page for unfiltered pages and common states, and to the
number of items scanned until enough matches are found for rare states: the
state is not persisted, because the action journal is append-only and
projecting it into an indexed column would need a maintained denormalisation
in the execution service plus a migration, which this change does not take.
Listing does not load original bytes.

Cursors never disclose an unreadable row. Without a `cursorKey` in the
service options, every cursor (each row's and `nextCursor`) names a row the
actor can read (the last one when a page stops early); a page that spends its scan limit before filling hands back
the last such row, and one that found none fails closed with
`IntakeScanLimitError` (`Intake scan limit`, no id or time). A run of rows the
actor cannot read (refused by the captured ceiling or the execution gate, or
stored with a non-canonical receipt time) at least as long as the scan limit
therefore stops an unkeyed walk there; readable rows that the `state` filter
excludes never count toward such a run. With a `cursorKey` (a server secret of at least 32 bytes), every
cursor is sealed with AES-256-GCM, bound to the tenant, confidential scope and
actor, and a budget-stopped page returns a sealed position past what it
skipped, so the walk always progresses. Sealed cursors have a fixed length
(the plaintext is padded to 1024 bytes) and a fresh nonce per seal, so neither
their length nor their bytes reveal anything about the stop row. `scanned` is for trusted host
accounting and must not be sent to clients; a short page with a cursor tells
a caller only that unlisted rows exist, never which.

Newest-first paging relies on `intake_items_received_idx`
(`tenant_id, confidential_scope_id, created_at, id`), the full ordering key, so
an unfiltered page is a backward index scan that stops at the page boundary;
the foundation suite asserts that plan on both engines (SQLite
`EXPLAIN QUERY PLAN`, PostgreSQL `EXPLAIN`), with the per-row state counters
served by `intake_actions_item_idx`. On SQLite the page query pins the index with `INDEXED BY` (except under an
id restriction, where direct id lookups are cheaper), because without planner
statistics SQLite otherwise picks `intake_items_expiry_idx` plus a sort; the
SQLite plan check runs without `ANALYZE`. A deployment must have applied the
manifest migration, or the page query fails with a missing-index error. This package ships no
migration files: indexes are declared on the model, the build emits them into
`dist/manifest.json`, and `smrt db:migrate` / the public migration API create
them, which is how `intake_items_receipt_idx` shipped. Deploy the manifest
migration before upgrading hosts; `db:status --parity` reports the index as
missing until then.

Supply four application adapters: `upload(files, requestId)` (authenticated
receipt plus first extraction request), `assignment(itemId)` (durable read),
`assign(input)` (manager authorization, eligible assignees, durable CAS and request
replay protection), and `evidence(part)` (safe label/text or authenticated
same-origin URL). Optional `label(item)` changes presentation. Optional
`assignments(itemIds)` reads one page's assignments in one batch (otherwise
`assignment` runs per row), and optional `assignedItemIds(assigneeId)` lets
`list` push the assignee filter into the page query (junk ids are dropped, not
fatal); without it an assignee filter scans further pages and filters by
`assignment`, which stays correct but costs more rows. The page's continuation
is always the last row actually returned, so an assignment that changes
between the page read and the assignment read costs at most one extra scan and
never skips or repeats a row. Optional
`enableFeedback: true` exposes the optional feedback callback when the service
has feedback configured. Optional `onSplit(itemId, revision)` wakes the host worker after the durable extraction
request; repair dispatches if wakeup fails. The factory creates no assignment
schema and grants no permissions. Create it per session, authenticate every HTTP
call and enforce CSRF before dispatching a mutation.

`GenerationAnalysisOutput` is exported by `/dto` and describes the interpretation
wrapper `{ proposals: GenerationOutput }` under `analysis.result.output`.
The factory unwraps this into `ItemReviewView.generation`. Stale generation is
omitted while authorized saved reviews remain available; access denials propagate.
The reference application still owns its fixture provisioning and HTTP transport.

## Explicit upload retries

The inbox retains selected original files and the receive request identity when
upload fails or acknowledgment is lost. Retry Upload explicitly with the same
selection; Refresh does not replace that identity. Selecting files again starts a
new receipt identity, even when names match. Successful upload clears the selection
and identity. Replacing the authenticated host/context or destroying the component
discards both and fences late completion from the prior context. No automatic
upload retry or authorization bypass occurs.

The inbox clears only its native file-input value when opening the picker, so
choosing the same local file explicitly starts a new upload identity. Opening
then dismissing the chooser preserves the separately retained originals and
request identity for retry; it does not clear the shared FilePicker's native-form
behavior. Successful upload and host/context disposal still discard retry state.
