# Authenticated review surfaces

`@happyvertical/smrt-ingestion/svelte` exports `IntakeInbox`, `IntakeReview`,
`IntakeWorkspace` and `EvidenceViewer`. The browser-safe DTO entry exports their `IntakeReviewHost`
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
read (the host `authorize` returns false or throws `IntakeAccessDeniedError`)
is skipped before projection: the page is filled from readable items only, in
50-row batches, and `nextCursor` names the last emitted item and is present
only when a further readable item was actually found. Neither the entries, the
page size nor the cursor reveal a hidden item. If one call has to skip 1000
hidden submissions it fails with `Own proposal scan limit` rather than return a
short page or a cursor that stops inside the hidden run; this error is the only
signal, and it says only that such a run exists. Any other `authorize` error
propagates instead of shrinking the list. An item that is still readable but
whose reviews are denied is returned as `{ item, reviews: null, unavailable:
true }`: that covers ingestion's own denials and any throw from the host
`assertTarget` (deleted or revoked targets), whose text is never returned.
Integrity, validation and database errors from ingestion itself propagate. The
reviewer `listReviews` surface keeps propagating host target errors unchanged.
`submitOwnDecision` takes the same `ReviewInput` CAS fields and request ID as
`submitDecision` and accepts `approve`, `reject` and `defer` only; `correct`
belongs to the reviewer surface. It runs under the `review_own` execution
operation: the host's `authorize` must return `submitter: true`, the resolved
policy must have `submitterReview` enabled, and the recorded submitter must be
the current actor and also the receipt's captured execution principal (the
identity the effect runs as), checked under the item lock and again at apply.
A receipt captured for a bot or service principal is never self-approvable. Policy enablement, handler/operation allowlists, captured
ceiling, confidential access, retention and the first-valid-decision lock are
unchanged. The decision is a human decision by that actor, recorded with
`mode: 'review_own'`; reviewer decisions carry `mode: 'review'`. In both modes
`selfDecision` is true exactly when the deciding actor is the item's
submitter, so a reviewer approving their own submission is never independent
review. A self-decision is not a reviewer judgment: it never feeds
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

## Reviewer-chosen actions and "handled, no action"

A reviewer is not limited to model suggestions. `ItemReviewView.catalog` carries
the handlers the item's catalog currently offers (`listHandlers`, discovery media
types and live preview authority; it is presentation, never a grant). The optional
`startAction` callback forwards `StartActionInput` (`itemId`, `handlerId@version`,
explicit `args`, `requestId`, optional `reason`) to `startReviewerAction`, which
requires the current reviewer grant under that handler, a completed or partial
attempt on the current analysis revision, and an operation handler the item's
evidence media types offer. Plan handlers go through `previewPlan`. The server
creates an action keyed `reviewer:<requestId>` with origin `reviewer-selected`
(`createAction` refuses that key prefix and origin, so process authority cannot
mint reviewer provenance; re-previewing such an action with `previewProposal`
needs the reviewer grant and keeps its handler fixed, so only its arguments can
be corrected),
runs the handler's normal `validate`/`preview`, publishes a `waiting_review`
revision and requires the same explicit approval and apply as a generated
proposal. Replays with the same request return the same review; changed arguments
or reason conflict. Such actions are never automation-eligible: `authorizeAutomatic`
refuses them regardless of policy opt-ins. The UI pre-fills arguments only from a
same-handler suggestion (for example a `needs_review` one) and a single original's
evidence references, lists the required fields still missing, and submits exactly
what the reviewer typed. An item whose current attempt failed outright must be
reprocessed first; an interpretation that completed with `provider_error`,
`unknown` or no suggestions can be acted on directly. `ReviewAction.origin`
exposes the provenance so `ActionReview` can label human-started actions.

The optional `resolve` callback forwards `ResolveItemInput`
(`disposition: 'resolve_no_action'`, `requestId`, optional `reason`) to
`resolveItem`. It needs reviewer authority under any handler the item's captured
ceiling offers and refuses while an action is `authorized` with a live approval,
`executing`, `outcome_unknown` or `succeeded`; waiting, deferred, rejected and
failed actions, and authorized ones whose approval expired, may remain (neither
an exhausted failed action nor a lapsed approval can be rejected, so they must
not keep the queue open). Afterwards only reject remains: those actions can no
longer be approved, corrected, deferred, re-previewed, retried, applied or
automated. `submitDecision` refuses every decision but `reject`, no new revision
is published for the item, `applyAction` rechecks the disposition before any
effect, and `analyze`, `reviseLogicalSplit` and `createAction` refuse the item
under its lock before any write, so it is never reanalysed, re-split or given a
new action. `resolveItem` supersedes any queued or running analysis under the
same lock and `claimAnalysis` refuses a resolved item, so no provider is called
after a human closed it; the item's `processingState` keeps its last value (it
describes analysis, not review), and the inbox state `resolved` is authoritative.
`publishProposal` (process authority) refuses a resolved item and any
reviewer-selected action. The UI hides Approve, Defer, Apply, every edit control, suggestion
preview and split controls on a resolved item.
Resolved items hide the instruction editor and stop reinterpretation polling, even if an older processing projection is still queued. Recording an instruction cannot append a new revision after resolution.

Paged lists project the resolved state and disposition time in the same bounded, scope-filtered query, so state filters and row controls agree with a full item reload.

The append-only `intake_dispositions` record is terminal: replaying the same
request returns the same disposition, any other request conflicts, and
`startReviewerAction` refuses the item. `IntakeItemDTO.disposition` projects only
`{ state: 'resolved', at }` to any item reader (`listItems` reads it in the same
statement as the page); the reviewer and reason are returned only by
`getItemDisposition`, which requires reviewer authority, and the review hosts put
them on `ItemReviewView.disposition` (omitted when that read is denied, so the
view shows only "Handled, no action"). `loadReviewSummary` reports inbox state `resolved` unless an action
actually succeeded. Privacy deletion and retention expiry redact the reason and
reviewer (`intake_dispositions.data`) and keep only the kind. The disposition is
distinct from `reject`, which still means the proposal was wrong. Closing an item
records `reviewer_routing` feedback immediately; a started action records it only
when the reviewer approves it (see FEEDBACK.md). Capture is an optional projection
that never vetoes the decision or disposition.

`startReviewerAction` applies the handler's discovery media types and the live
reviewer grant/policy for that handler. It intentionally does not apply the
proposal catalog's provider-policy filter or `maxHandlers` slice: those bound what
a model may be offered, and a human choosing a handler sends nothing to a
provider. The UI picker shows the offered catalog, so a handler hidden from it is
only reachable by a reviewer who already holds `review` authority for it. The maintained
browser fixture serves both operations behind CSRF and the same session scope.

## Single-page triage workspace

`IntakeWorkspace` (#4215) composes the existing pieces so a reviewer works the
whole queue on one page: the paged inbox as a list pane, the review view of the
selected item beside it (the original above its action form), and the
reviewer-instruction message box of the item pane. Props: `host`, `contextKey`
(replace on session change, as for the other components), optional initial
`itemId`, `pollMs`, `rowAside` and `onselect(itemId | undefined)`, which only
reports the selection (to keep a URL in step) and never navigates. It adds **no
host callback and no server authority**: every read is the host's `list` and
`load`, every action still goes through the handler preview and an explicit
approval and apply under the approver's live grants, and the message steers the
model only, exactly as in `IntakeReview`.

- **Inline original.** In the item pane `EvidenceViewer` shows one part at a
  time (`layout="pager"`), opening on the first part that renders inline (the
  uploaded file rather than its capture record), with previous/next original.
  A PDF with more than one *observed* page (extraction locations or proposed
  page groups; `pages` prop) gets previous/next page, which reloads the frame
  at the same-origin URL plus `#page=n`; only `evidenceUrl`-approved URLs ever
  reach a frame. `IntakeReview` gets the same page navigation over its
  unchanged stacked list of parts. The chosen part and page belong to the item
  view (bindable `chosen`/`page`), so they survive in-place reloads, Prepare
  review, Approve and Apply.
- **Keyboard.** J/K and Alt+Down/Alt+Up move to the next/previous row (loading
  the next page at the end), ignored while focus is in a text field, select or
  editable region; "Previous item"/"Next item" buttons carry
  `aria-keyshortcuts`. The selected row is `aria-current`, and every selection
  moves focus to the item pane region, named by the row's label. A navigation
  that waited for the next page is dropped if the reviewer chose another item
  meanwhile.
- **Unsent input.** The pane holds unsent input when it has instruction text,
  an edited suggestion draft or split draft, a chosen start handler or start
  reason, a no-action reason, or an action editor with edited arguments, a
  reason or a feedback comment. It is read from the drafts themselves, so it
  holds while a reload has cleared the view; while the view is denied nothing
  is shown and nothing counts (the drafts stay in memory and return with an
  authorized refresh, as before). A reviewer-initiated move (J/K, Alt+arrows,
  Next/Previous item, a row's Review button) then asks inline, in a group
  labelled by its note: "Stay on this item" takes focus and returns it to the
  field the reviewer last used; "Discard and open the other item" proceeds.
  When an item is closed without action, input a closed item cannot take
  (instruction, suggestion drafts, a started action) is discarded.
- **Live state.** A row's status follows the item: "Interpreting…", "Ready to
  review", "Needs review" with missing argument names or the generation
  outcome, "Awaiting approval", "Approved, not yet applied", "Failed" with a
  safe category, "Handled, no action", or the listed inbox state. Rows the
  reviewer has not opened show the listed state only; reasons come from a
  loaded view, never from server exception text. The open item's own polling
  (`ReviewView`, unchanged backoff and three-failure fail-closed) reports each
  displayed view and the workspace patches that row in place
  (`InboxView.patch`, keeping the listed label and preview), so the row and the
  form never disagree and the list is **not** re-listed per tick. An item the
  reviewer leaves while its stage is in flight, or before the pane showed the
  result of its last operation (an instruction just recorded), keeps
  following: the workspace re-reads followed items with the same `load` (first
  review page) on the pane's backoff, at most **5** reads per tick, one after
  another, least recently read first (so every followed row is reached), with
  only one tick running at a time. At most **20** items are followed; beyond that the longest-followed
  one stops. An item stops being followed when it settles, its view is denied,
  three reads in a row throw, its row leaves the displayed list (a filter
  removed it), or the cap drops it; a denial, the failure stop or the cap drops
  its cached status and restores its entry exactly as its page read returned
  it (never a patched entry). A denial in the open pane (a failed action or the
  pane's own fail-closed poll) does the same and the item is not followed when
  left. A settled stage that was seen running is announced in a polite status
  region ("badger-po.pdf: Ready to review"), only while its row is displayed.
  Other rows update on Refresh, a filter change or when opened; there is no
  streaming. While a refresh or "Load more" is pending, the displayed rows stay
  (controls disabled) and keep taking patches; when the page arrives the open
  row and followed (or just settled) rows are patched again from their latest
  views, so an older page never regresses them. "Load more" continues the
  filter the rows were listed under, not filter inputs edited since, and does
  not repeat a row already shown; if it fails, the displayed rows and the
  cursor stay and a note asks to try again.
- **Approve and advance.** After an approve, apply or "Handled, no action" whose
  reload left nothing for the reviewer (closed without action, or an action
  succeeded and none is waiting for approval, waiting to be applied, executing,
  unknown or failed; stale, rejected and deferred actions do not hold it), the
  item's row is patched and leaves the list when it no longer matches the
  listed state/assignee filter, and the next row that is not closed or
  completed opens and takes focus, with no navigation and no re-listing. An
  approval that leaves an apply step keeps the item open with Apply in place.
  Unloaded saved-review pages and an active background stage also prevent
  settlement. Advancing skips completed inbox pages until a reviewable row
  appears; a page that makes no progress stops the walk.
  It never advances over unsent input on the same item: the item stays open,
  the input stays, and a note says it is finished but has unsent input; the
  reviewer moves on explicitly, through the confirmation. Input typed while
  automatic advance awaits another inbox page also holds the current item.
  When the next items must be loaded and that read fails or cannot start (a refresh is pending),
  the item stays open with a note to try Next item again rather than reporting
  an empty queue. The open item stays listed while the reviewer works on it
  even if its state stops matching the filter; it leaves once they move on.
  When nothing is left the pane says so. The per-row "Handled, no action"
  control is hidden in the workspace (`resolveInRow={false}`) so closing always
  goes through the item pane and advances.


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
action/plan preview CAS lookup, decisions, apply, corrections, candidates, split,
feedback, the offered `catalog`, `startAction` and `resolve`. Any catalog
failure (not configured, bound exceeded, denied) omits `catalog`, so the picker
disappears while existing reviews stay reviewable; item, review and evidence
denials still propagate as before; the reference host (`reference/review-host.ts`)
degrades the same way. Repeated
preparation of an unchanged authorized suggestion retains
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

Workspace ordering also protects an open item during an awaited automatic page walk:
the selected row remains until navigation succeeds. Applying an action is disabled
while that action card holds unsent arguments, reason, or feedback comment. A list
refresh retires earlier follow snapshots; only follow reads started after that
page request may override its rows, so a newer refresh cannot be regressed by an
already settled or older in-flight follow read.
