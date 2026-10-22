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

A `needs_review` suggestion is completable, not only rejectable (#4208). The
component shows its `missingFields`, an editable `Suggested arguments (JSON)`
draft prefilled from the generated arguments, and the candidate picker for
declared candidate fields; Prepare review stays disabled while required fields
are still missing from an unchanged draft. An unchanged draft previews the
generated snapshot as before; an edited draft is sent as `preview({..., args})`,
which the published host publishes through the ordinary `previewProposal` /
`previewPlan` with the same `ui:<index>` intention, never by rewriting the
generation. The handler validates the human arguments again before a
`waiting_review` action exists, approval remains a separate explicit decision,
`ActionReview` lists required arguments missing from the current draft while
editing, and no authority or automation eligibility is added: a failed attempt,
an unoffered handler or a foreign stage is still refused by the host.
`preview` throws on every failure, as before. When the handler's argument
schema or `validate` refused the arguments being previewed (operation preview,
which also carries corrections, or plan preview), the server throws
`HandlerArgumentsInvalidError` (`name` set, messages unchanged). Apply-time and
external-send revalidation and result-schema checks keep a plain `Error`. The component shows an inline message and
keeps the view and draft when `preview` either rejects with an error whose
`name` is `HandlerArgumentsInvalidError` or resolves `{ rejected: 'invalid' }`
(`PreviewRejection`). A transport that crosses a process boundary preserves
the inline UX by keeping that name (for example re-throwing an `Error` with
`name = 'HandlerArgumentsInvalidError'` in the browser callback) or by
returning `{ rejected: 'invalid' }` for that case only, as the maintained
fixture's `previewForReview` does. Without either, the refusal behaves like
any other failure: the view is cleared exactly as before this change, and the
reviewer's in-memory draft returns after an authorized refresh. Every other
thrown preview or candidate-search failure (denied, revoked, unavailable or
unknown) clears the view.
Unsent drafts live only in component memory, keyed by attempt and suggestion
index. They survive Refresh, a failed callback, an action on another card and a
transient `unavailable`/`stale` reload; a `revoked` or `expired` result
discards them, a successful preview clears that card's draft, and an available
reload drops drafts for attempts or cards no longer offered.

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

## Submitter-scoped decisions

For trusted internal sources the person who submitted an item may confirm or
decline their own proposal without the reviewer inbox. `listOwnProposals`
returns only items whose server-recorded `submitter_id` equals the current
authenticated actor, each with its bounded saved review page reloaded under
current item, handler and target authority. An item the actor can no longer
read is skipped before projection: the page is filled from readable items only
and `nextCursor` names the last emitted item and is present only when a further
readable item exists, so neither the entries, the page size nor the cursor
reveal it. The scan is bounded at 1000 candidate rows per call; a longer run of
unreadable submissions fails closed with an error rather than a partial
disclosure. An item that is still readable but whose reviews are denied by
ingestion's own item, handler or policy authority (`IntakeAccessDeniedError`)
is returned as `{ item, reviews: null, unavailable: true }`; integrity,
validation and database errors, and other host callback errors, propagate.
`submitOwnDecision` takes the same `ReviewInput` CAS fields and request ID as
`submitDecision` and accepts `approve`, `reject` and `defer` only; `correct`
belongs to the reviewer surface. It runs under the `review_own` execution
operation: the host's `authorize` must return `submitter: true`, the resolved
policy must have `submitterReview` enabled, and the recorded submitter must be
the current actor. Policy enablement, handler/operation allowlists, captured
ceiling, confidential access, retention and the first-valid-decision lock are
unchanged. The decision is a human decision by that actor, recorded with
`mode: 'review_own'` and `selfDecision: true`; reviewer decisions carry
`mode: 'review'`. A self-decision is not a reviewer judgment: it never feeds
automation eligibility (machine authorization remains the separate evaluated
`kind: 'machine'` path) and its feedback events carry the same marker. The
`unavailable` entry discloses nothing about the denied handler or target.
`applyAction` then runs once under the approver's live grants exactly as
for reviewer decisions. Hosts render this surface from their own authenticated
session; presentation state confers no authority, and a source payload cannot
nominate a submitter.

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

## Reviewer instructions

`recordReviewerInstruction({itemId, attemptId, expectedRevision, text,
requestId})` records a plain-text instruction for one item ("This is a customer
PO from Badger; file it, do not bill it") as the second kind of **human
correction**. It is authorized exactly like `reviseLogicalSplit`: the current
generation must pass the same-executor catalog/candidate gate and the reviewer
grant plus policy reviewer list, and authority is checked before mutation and
again before publication. Process access, `analyze`, and a client payload cannot
mint one: `analyze` rejects a `reviewerInstruction` key on an extraction
configuration, and an interpretation copy that differs from the pinned
extraction's record fails with `Generation evidence changed` before provider
disclosure. Text is required, trimmed-nonempty and at most 4,000 characters.

The record is immutable: `{id, text, actorId, recordedAt, supersedesId, digest}`
plus the request binding, written into a new extraction configuration beside
any existing split correction. Recording supersedes current suggestions and
approvals, queues the normal fenced re-extraction and interpretation through the
existing dispatch path, and returns immediately; the reviewer keeps working
while the item reports `processing`. `prepareGeneration` copies the instruction
into the interpretation configuration, the generator receives it only after its
digest matches the authoritative extraction record, and saved generation
provenance records `reviewerInstruction: {id, digest}`. A later instruction
records `supersedesId` and replaces the earlier one for future interpretations;
`listReviewerInstructions(itemId)` returns the full history, newest first, and
history is never deleted. The instruction steers the model only: it cannot add
handlers, candidates, schemas, permissions or automation eligibility, replies
are validated as usual, and suggestions still require explicit preview and
approval. A replay with the same request ID returns the same revision; a changed
text under the same request ID conflicts.

**Cost.** Each recorded instruction appends a new extraction revision, so the
item is extracted again before it is interpreted again: cheap for embedded-text
PDFs and plain text, but OCR/speech hosts spend provider budget per instruction,
exactly as they do per split correction. The pinned extraction is not reused
because the interpretation contract requires its source to be the immediately
preceding revision and `getCompletedAnalysis(itemId, attemptId)` serves only
the current revision (PROPOSALS.md, "Durable stages"); reusing it would mean
weakening that predecessor pin, which protects every generation from an
intervening reprocess, so this feature follows the split path instead.

**State and failure.** An in-flight stage (queued/running) reports the item as
`processing` even when earlier, now-stale actions exist. If the re-extraction or
interpretation fails, `getReinterpretationState(itemId)` returns the latest
attempt's safe failure category and the latest completed generation attempt;
the host projects them as `instruction.failure` and `instruction.binding`, and
`recordReviewerInstruction` accepts that historical attempt as its anchor when
`expectedRevision` is the item's current (failed) revision and no later
**interpretation** completed and nothing is queued or running, so the reviewer
can retry or change the instruction after either stage fails. A completed
extraction whose own interpretation failed belongs to the failed attempt, not a
newer result; a completed extraction whose interpretation has **not been
appended yet** is in flight (the host is between stages) and is refused with
`ReviewerInstructionStaleError` (`Stale reviewer instruction`), so a second
reviewer cannot pre-empt it. That gap expires: once the extraction attempt's
completion plus the item's analysis lease duration (`limits.leaseMs`, the lease
`claimAnalysis` grants) has passed with no interpretation appended,
`getReinterpretationState` reports `failure: 'not_started'` with the retry
binding and the guard allows the retry. `not_started` means **the
interpretation did not start within the lease window**: the host crashed,
threw between `prepareGeneration` and `analyze`, or its queue is merely slow.
Pre-empting a slow but healthy host is safe because `analyze` refuses an
interpretation whose pinned extraction is no longer the item's latest, under
the item lock and before anything is superseded
(`GenerationSourceStaleError`, nothing appended): the slow host's late append
cannot clobber the retry. Missing or malformed timing (no attempt, no
`completedAt`, non-finite `leaseMs`) counts as already expired rather than
holding retries forever. The "still being re-read" note shown after a stale
result is cleared by the next reload that shows the item settled; the draft
then carries a persistent "This item changed while you were writing; your
instruction was not recorded." note (any stale cause: another reinterpretation,
a split, or a host reprocess) until the reviewer edits or resubmits it. The guard and
`getReinterpretationState` share one predicate, and the latter's
`reinterpreting` flag (projected as `instruction.reinterpreting`) is true in
the gap too, so the component keeps polling and keeps Re-read disabled there.
The published host maps two typed errors to `instruct` results:
`ReviewerInstructionStaleError` → `{ stale: true }` (refresh-and-retry: reload
with a note, draft kept) and `ReviewerInstructionInvalidError` → `{ invalid:
true }` (empty, whitespace-only or over 4,000 characters: shown inline, draft
kept). Neither is a denial. Custom hosts should map them the same way; a host
that lets either propagate as a thrown error makes the component treat it like
any other failed mutation, i.e. a whole-view deny with the "view unavailable"
message, as before these results existed. The maintained fixture's
`/api/instruct` now answers an invalid text with HTTP 200 `{ invalid: true }`
instead of 409. A retry from an older anchor builds on the **whole configuration**
of the newest extraction after it (replacing only the instruction), because that
is the item's current configuration: corrections chain forward through it and a
host reprocess replaces it. So a split followed by a failed stage is never
silently dropped, and a failed reprocess's changed configuration is neither
reverted nor overlaid with a split it dropped. **Concurrency.** `recordReviewerInstruction` and `reviseLogicalSplit` each
run their whole decision in one transaction under the item row lock: the
anchor snapshot read takes the lock first, the execution authorization of
that snapshot takes it again (`UPDATE intake_items` row lock), the guard step
re-asserts it explicitly, and
the request-key replay check, the revision and later-work guards, the
carried-forward split, the history read that sets `supersedesId`, and the
append all run under it. On PostgreSQL a second reviewer at the same revision
blocks on that lock and is then refused (`ReviewerInstructionStaleError` /
`Stale logical split`), so the ledger cannot fork; an instruction racing a
split (in either order) is refused rather than built from the pre-split
configuration; and a double-click whose duplicate commits after the unlocked
replay check is answered as a replay of the committed request, not a conflict
or a denial.

**Host reprocess.** A host reprocess (a plain `analyze()` extraction the host
configures itself) cannot carry human corrections — `analyze` rejects
`humanCorrection`/`reviewerInstruction` on extraction configurations — so it
drops the split and the instruction alike, and neither is applied to its
interpretations. The instruction is then reported as `dropped`, not pending:
`getReinterpretationState().instructionInEffect` names the instruction the
newest extraction carries (verified by digest) and is null after such a
reprocess. History is unchanged; the reviewer can re-record the instruction,
which supersedes the dropped one.

`ItemReviewView.instruction` exposes `current` (the latest recorded instruction
still in effect, i.e. carried by the newest extraction), optional `dropped`
(the latest recorded instruction a reprocess dropped), `applied` (the
instruction the displayed **generation** ran under; a completed extraction alone
applies nothing), `stale` (the displayed suggestions predate the current
instruction), optional `failure` and optional `binding`. Feedback examples that carry instruction
text count it toward the feedback byte budget (FEEDBACK.md). The optional host callback
`IntakeReviewHost.instruct` is implemented by the published adapter when the
service supports it, with an optional `onInstruct(itemId, revision)` wakeup
mirroring `onSplit`. The review component renders "Instructions for the
assistant" with "Re-read with these instructions", shows "Reinterpreting…" while
the item's stage is queued/running, repeats the existing authenticated `load`
on `pollMs` (default 2 s, backing off to 5×) and patches the view in place —
drafts, split edits, focus and the evidence viewer survive and no loading
placeholder is shown — stops when the stage is no longer in flight, and then
shows the instruction that produced the current suggestions, marking a
superseded one as stale. An explicit host denial on a poll tick fails closed at
once; a thrown tick is treated as transient (view and drafts kept, a
"Couldn't refresh; retrying." note, backoff continues), but because hosts may
also throw for revoked access, three consecutive thrown ticks fail closed.
**Hosts must signal revocation by returning `availability: 'revoked'`** (or
another non-`available` state) from `load`, not by throwing: a returned denial
clears the view on that tick, while a host that throws on revocation leaves the
already-displayed content visible until the third thrown tick (about 10 s at the
default interval and backoff) before the view fails closed.
Split drafts survive a refresh only when the reviewer edited them. A failed stage shows its safe category with the form
still available. There is no
streaming channel; status is read through the existing item/analysis APIs. The
maintained fixture records the instruction durably and then runs the stages in
the background so the browser proof exercises the in-place update.

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
same-origin URL), which `load` calls for every part and `list` never calls;
`load` sets no row preview on its entry.

Row previews are opt-in through an optional fifth adapter,
`rowEvidence(rows)`. When it is supplied, `list` reads the page's durable
evidence metadata with one `service.listEvidence(itemIds)` query (at most 100
ids; items the scope cannot read, and expired or inactive items, are omitted
without disclosure; the host `authorize` runs once per distinct captured
ceiling through the same gate as `listItemsPage`, so a refusal or a
malformed captured ceiling hides the item and a failing `authorize` rejects
the page; an item whose stored data does not parse is skipped by both
`listItemsPage` and `listEvidence`, never fatal). It then calls `rowEvidence`
once with each row's primary part (`{ itemId, evidence }`) and publishes the
returned `{ label, viewUrl?, thumbnailUrl? }` as `InboxEntry.evidence`
(`{ evidence, label, viewUrl?, thumbnailUrl? }`, never text). Build those URLs
from metadata without reading bytes; if `rowEvidence` throws or returns a
malformed answer, the page still lists without previews, and a row without
durable parts never gets one. When it is omitted, rows show no original link.
Either way `list` reads the page's evidence metadata once, in that same query,
so the row label can use the original filename; it never reads original bytes
and never calls `evidence(part)`. The primary part is chosen by role, not media
type: the shallowest child part when any part has a parent (an upload's file
under its capture record, an email's first attachment under the message, even
when that child is JSON), else the first root part (a watched-folder file);
part ids sort numerically. `IntakeInbox`/`InboxView` accept an
optional `rowAside` snippet receiving the `InboxEntry`; without it a row renders
the host's "Open original" link (new tab) and thumbnail when the URLs are
same-origin; each link's accessible name is "Open original: <row label>", and
a row shows no wrapper when neither URL is usable. The slot is a plain `div`,
not an `aside` landmark, so a page does not add one landmark per row. Optional
`label(item, evidence)` changes presentation; `evidence` is the item's durable
parts with the primary part first, and the default label is the primary part's
own original `filename`, else `Intake <8 hex>`. Optional
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
