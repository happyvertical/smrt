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
first (`intake_items.created_at`, id tiebreak) through `service.listItems`.
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
view would narrow past its deadline is simply not listed. An item whose bound
handler the actor cannot currently read is not listed at all, rather than
listed with a state derived from actions the actor may not see; actions
without a proposal bind no handler and are not gated, as in `listReviews`.
Handler bindings (handler id and version, projected in SQL, distinct per
item) are read once per fetched batch for the rows that passed the item-level
gate. Note the host cost plainly: the execution `authorize` callback runs once
per distinct (item, handler) among the rows scanned, memoised within the call
and bounded by rows scanned (at most `ITEM_SCAN_CEILING`), in host code rather
than as N+1 database reads. Denied or unreadable rows are skipped without
disclosure and the page refills from the next rows; refills grow from the page
size to 100 rows per query, so a fully denied scope costs about a dozen page
reads and as many binding reads per call. One service call examines at most
`ITEM_SCAN_CEILING` (1000) rows, or the caller's smaller `scanLimit`, and
reports the count as `scanned`; when a mostly-denied scope reaches the ceiling
the page comes back short with a `nextCursor`. `scanned` counts rows the page
query returned; with a rare `state` filter the database itself may examine
many more rows inside the query before returning them, which the ceiling does
not bound. The host `list` passes its remaining budget as `scanLimit`, so the
rows scanned across the service calls of one host call never exceed 1000: a
short service page with a cursor, or an exhausted budget while filtering by
assignee, ends the host call with the same cursor and the caller continues.
Only rows the service wrote are supported: cursors carry the normalised ISO
receipt time the service stores, and a row whose stored receipt time is not
that text is skipped and counted like a denied row, reported by id only when
a page would have to continue from it.

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

Newest-first paging relies on `intake_items_received_idx`
(`tenant_id, confidential_scope_id, created_at, id`), the full ordering key, so
an unfiltered page is a backward index scan that stops at the page boundary;
the foundation suite asserts that plan on both engines (SQLite
`EXPLAIN QUERY PLAN`, PostgreSQL `EXPLAIN`), with the per-row state counters
served by `intake_actions_item_idx`. The proof holds with planner statistics:
without `ANALYZE`, SQLite preferred `intake_items_expiry_idx` plus a sort in
the suite, so SQLite deployments should keep statistics current
(`ANALYZE` / `PRAGMA optimize` after bulk loads); PostgreSQL autovacuum
analyses the table on its own. This package ships no
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
