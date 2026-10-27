# Physical workbook contract

`WorkbookService` extends `SubmissionService` with the same actor-bound authorization,
private asset runtime, transaction executor and guardian Grade boundary. Both
LearnerAuthorizer and CatalogAuthorizer receive the active executor. Host session
heartbeats and current permission checks must use that supplied executor, including
nested guardian review; a captured outer pool can wait on its own transaction.
CatalogService obtains the executor through the public collection.db getter and
fails closed when its four catalog collections do not share the same handle. It is an
additive API; existing Submission/Grade consumers retain their contracts. The six
closed `Workbook*` models are package-manifest models. Apply normal application
schema migrations before using them; the service never creates runtime schema.

A guardian calls `resolveWorkbookActivity` with an explicit learner, workbook key,
title, edition (empty means unknown), page key and printed page label. Keys identify
the physical copy/edition and page occurrence, including section/side where needed.
Names and photo hashes do not establish identity. A conflicting reuse fails. One
private personal-use-copy course/enrollment per learner/workbook supplies internal
submission scaffolding. The public page API needs no course-building workflow.

`captureWorkbookWork` owns original files through SubmissionAsset and creates an
immutable attempt with source SHA-256 hashes, actual page bounds, actor, capture
time, assistance, correction predecessor/episode, policy version and effective
review-required flag. Assistance defaults to `unknown`. Capture retries reuse the
same Submission/attempt and reject changed bytes or help claims. A correction
requires the same learner/activity/current predecessor and stays in the same
practice episode. Analysis/reanalysis adds revisions, never practice attempts.
Existing LessonProgress.attempts remains a compatibility capture counter.

The workbook review-required policy defaults on and is shared by its pages.
`setWorkbookFeedbackPolicy` uses expected policy version; existing capture snapshots
remain unchanged. Policy changes cannot erase prior disclosure. Guarded capture,
policy and decision writes serialize on the learner within the active transaction.
Ingestion target resolution acquires that learner lock before the enrollment lock,
matching capture/review order. Guardian apply follows authorized timeline cursors
when locating a preserved assessment on an older attempt.
Composite mutations also use the education transaction's serialized composite
queue, allowing inherited queued capture/review writes without queue recursion.
Any swallowed mutation error still aborts the complete transaction and file rollback
uses the inherited fresh-file compensation ledger.

## Structured assessment and real ingestion

`WorkbookAssessment` version 1 has stable question IDs, original/corrected prompt
and answer text, explicit result/reason, nullable points, feedback, retained source
anchors and curated concept mappings. An anchor names an owned asset plus SHA-256,
one-based verified page (or null for a whole-file PDF source) and normalized
x/y/width/height rectangle. Ingestion proposals never generate rectangles: the
service uses [0,0,1,1] and explicit source/page grounding with limitations. The provider wire contract
contains evidenceId only, with no page/rect selector. An image is a known single
page; PDF questions retain a whole original-file anchor with page:null, not a
claim about page 1. Extraction metadata remains provenance, never a model page
localization grant. Fictitious PDF
pages and foreign files fail. Missing, illegible, unsupported and absent questions
are unassessed; unassessed points stay null. Marking certainty, mapping certainty,
mapping review provenance and evidence limitations are distinct; absent certainty
is explicitly persisted as unknown. Reviewed overrides append new bodies and keep
original AI text inspectable.

The configurable vocabulary is trusted server configuration, not AI-created labels.
The default `WORKBOOK_MATH_VOCABULARY` has addition, subtraction and place value.
Other subjects may use an explicit curated `workbookVocabulary` on WorkbookService,
the ingestion handler factory and preservation helper. Unknown concept IDs fail;
zero mapped concepts is valid. AI mappings are proposed, guardian mappings reviewed.
Known question IDs are pinned across captures; exact prompts are pinned within a
capture's reanalysis only. Correction transcriptions come from the new capture,
so earlier answer-bearing prompts cannot override corrected work. Immutable
historical prompts remain unchanged. The public `getWorkbookQuestionIdentity`
returns IDs only: historical prompt text can itself include a learner response.
Handlers use printed number/occurrence/subpart when present; unnumbered tasks use
answer-free printed-task slugs with visible-task occurrence/subpart, never output
array position or learner answers. They
read prompt, answer, feedback and marks exclusively from current evidence. New
prompts should contain printed task text without the learner response. An absent
or ambiguously matched known question is unassessed/not_present with an explicit
limitation. Missing, duplicate, invented or foreign IDs reject the proposal; a
changed question order does not change identity. The ID check does not establish
semantic equivalence of printed tasks; uncertain correspondence requires human
review rather than an invented match.
A different page/question requires explicit new activity identity, never AI retargeting.

`captureEducationIntake` accepts optional `workbookActivityId`/`assistance` when its
service is WorkbookService. It preserves the existing return SubmissionView and
binds the workbook attempt/policy before the host queues processing.
`educationIntakeHandlers({workbookActivityId,...})` advertises a bounded JSON question
schema to real ingestion generation. Assessed results require reason none;
unassessed reasons require null points. Per-question outcomes must agree with
points. Correctness is independent of scoring: readable objectively solvable
arithmetic may be assessed without a printed rubric. When no point allocation is
evidenced, both `points` and `possiblePoints` remain null for every result,
including incorrect; never invent weights or mix null/numeric values. The
aggregate still counts correct/incorrect results while its score remains null.
Incorrect earns zero only when the possible-point allocation is known.
Model aggregate scores/narratives are not requested or trusted: exact
count summaries and points scores are computed from validated questions without
rounding or invented partial credit. Default legacy handlers remain compatible.
`preserveWorkbookIntakeAnalysis` reads the public immutable completed generation,
checks its exact submission and offered workbook schema, maps cited original
ingestion evidence by hash/order to retained education-owned files and imports one
validated proposal. Provider/model/version, configuration/rubric, source analysis
pin and proposal digest are durable provenance. Pending/failed processing produces
no assessment. Malformed/ambiguous/foreign-source proposals return typed needs_review with no
education revision or Grade. The host can offer retry/review without a route 500.
Authorization, durable-source integrity and database failures still throw. Repeated
transfer is idempotent by analysis attempt. Preservation must complete before host
scratch retention cleanup; there is no automatic retention bypass in this API.
The ingestion handler can apply only an exact previously preserved proposal through
guardian review; it never grants AI grade authority. No prose parsing is used. The generation configuration carries bounded source
hash/page-support provenance from the completed extraction before it ceases to be
the current analysis. This uses public ingestion APIs and is pinned by its
configuration digest; question anchors always use honest source-only grounding.

## Authority, visibility and history

`recordWorkbookAnalysis` accepts authorized submit context and writes provisional
AI revisions only. `reviewWorkbookAssessment` requires guardian authority, exact
source revision, expected current guardian head and stable request key. It appends
an immutable guardian revision recording sourceRevisionId, superseded head, actor,
time and decision reason. Changed retries conflict. Review of the current capture
uses the existing guardian Grade/progress boundary. Historical annotation changes
its evidence authority only and cannot grade or reopen its successor. Reanalysis
after a guardian decision remains provisional. A guardian can invalidate an outcome
with an unassessed replacement and a stated reason; old AI does not regain authority.

`releaseWorkbookFeedback` separately releases an exact revision using expected
current guardian head. New stale releases fail; accepted retry requests replay their
original result after later decisions. Release creates no Grade. With the gate off,
AI feedback is visible as provisional while authoritative grading still requires a
guardian. Gate-on learners receive no unreleased assessment payloads, scores or
hints. WorkbookService's ordinary getSubmission also redacts Grade for own learners;
hosts must route workbook reads through this service and prevent legacy routes from
serving workbook grades. Guardian history is complete; learners see only their own
work and visible revisions. Answer keys/source storage URIs never enter these DTOs.

`acknowledgeWorkbookFeedbackDelivery` is an authenticated own-learner acknowledgment
for an exact currently visible feedback revision. It deduplicates per actor/revision
and rejects withheld, foreign, sibling and guardian acknowledgments. Immutable
delivery events record actor/time and mean rendered/delivered, never read or understood.

`getWorkbookTimeline` uses education rows/assets without reading ingestion. It lists
newest captures/revisions first, includes all releases/delivery events and provides
cursor pagination (1–100, default 25). A guardian revisionId selector locates its
containing capture for evidence links. Guardian source IDs/actors/reasons remain
inspectable. Released historical revisions remain visible after supersession.

`getConceptEvidenceSummary` is guardian-only for this milestone. It recomputes from
current guardian revisions, separates provisional observations, and reports independent,
assisted and unknown evidence. Correction captures remain one episode; they cannot
be extra independent demonstrations. Every observation cites capture, question,
revision, episode, result, assistance and time. Unassessed work is excluded from
error/correct counts. Descriptive cues cite actual evidence: needs practice, improving
on this item, needs a fresh independent check, not enough evidence. No mastery
percentage, generic score comparison, hidden threshold or predictive label is used.

## Preserved processing status and retention

`getWorkbookPreservationState` authorizes exact actor/learner/activity/submission
and returns only the intake ID plus retained assessment/analysis IDs and the
interpretation revision. It contains no questions, scores, feedback or hidden
assessment payloads. New AI provenance records `analysisRevision` from the
completed interpretation snapshot, separately from its extraction-source pin.

`preserveWorkbookIntakeAnalysis` checks this education-owned state and the public
content-free ingestion item revision before requesting raw completed analysis.
An exact already-preserved revision returns `retained` immediately. Guardian
review, release, corrections and receipt expiry therefore do not force a stale
proposal reread or prevent durable education history from loading. The public
ingestion stale-snapshot guard remains unchanged and still rejects the old raw
snapshot after guardian grading. A genuinely new valid analysis can append a new
provisional revision; a novel stale analysis returns `needs_review/stale_analysis`
and creates no mark. Legacy retained rows without interpretation revision remain
readable when scratch is stale/unavailable or the public
ProposalsNotConfiguredError reports removed provider read configuration. A novel
analysis with no provider read configuration returns unavailable without import; an authorized current snapshot whose
attempt ID is already retained is also skipped before retry reconstruction.

Only the exact public scratch `Intake unavailable` response is translated to
retained history, or `unavailable` for a capture with no retained assessment,
after independent education authorization. Missing/pending current analysis may
return pending or retained. Unexpected configuration, integrity and database
failures still throw. This does not widen scratch access: no stale or unavailable
raw proposal is read, imported or used as grade authority. Hosts must also render
the authorized education timeline independently of optional scratch processing.

## Compatibility API privacy boundary

Workbook feedback is projected only from the revision/release workflow. The base
`SubmissionService` recognizes authoritative `WorkbookActivity` lesson ownership,
including calls through a plain service instance. Own-learner compatibility views
withhold Grade and grade-derived status; learner progress projections withhold
bestScore/completedAt and do not let completion alter next-lesson selection.
Guardian and ordinary non-workbook projections retain their existing behavior.
This applies in both feedback policy modes; direct feedback remains provisional
and does not authorize compatibility Grade disclosure.

Generic capture/resubmission rejects workbook enrollment or lesson scaffolding,
including idempotent retries. Only the protected exact-activity owning workflow
can capture workbook work. Hosts must call public
`assertNonWorkbookSubmissionScope` before legacy intake receipt creation and when
reading an old legacy binding, using authoritative enrollment, lesson and
predecessor selectors. `WorkbookWorkflowRequiredError` is a controlled denial.
The browser's optional workbook flag is never authority. Authenticated original
asset delivery remains a separate read authorization path.

## Validation and limits

`src/__tests__/workbook-workflows.ts` is the shared SQLite/PostgreSQL contract suite;
`workbook-service.test.ts` runs SQLite, and `workbook.optional.test.ts` runs against
an available isolated PostgreSQL database. Workers never provision service stacks.
Run package test/typecheck/build; the integration owner runs test:postgres and the
integrated review. Synthetic provider DTO tests establish transfer integrity, not
real handwriting accuracy. Actual provider/sample and app restart/retention
acceptance remain separate integration evidence. Family deletion/export/backup
policy and automatic lesson generation are not implemented by this milestone.

## Identity-independent work

[Photo intake](photo-intake.md#marking-before-filing) may own an explicit unfiled
work unit. Its nullable workbook FK is constrained to an exact retained receipt;
private enrollment/worksheet routing is technical rather than bibliographic.
The same attempt/assessment/review/release and concept-evidence contracts apply.
`filing` is optional on legacy-shaped DTOs and explicit on current projections.
Append-only filing changes display association only; it never moves immutable
learning evidence or changes captured review policy. Ordinary identified workbook
identity and generated-surface restrictions remain unchanged.

### Unnumbered visible questions

A printed question number is not required for marking. On the first valid
assessment, an unnumbered task may use `u:<short printed-task slug>:<occurrence/subpart>`
from current answer-free task text and unambiguous visible task identity. The
occurrence distinguishes tasks in the source, never positions in a generated
questions array. Responses, computed solutions and changing evidence UUIDs cannot
supply identity. Printed IDs remain useful where present; both forms share the
existing nonempty/unique ID schema and 200-character bound.

Once preserved, the exact ID set remains pinned on reanalysis and correction.
Reordering output does not renumber tasks. A cropped, duplicate or illegible task
whose correspondence cannot be established remains `unassessed/not_present` with
a limitation on its known ID; it cannot be silently relabeled as another task.
Historical IDs are correspondence hints, not evidence of current responses.
Missing IDs, collisions, changed ID sets and same-capture prompt remapping still
fail closed. The framework never inserts omitted provider IDs or parses prose to
repair malformed proposals.

### Semantic identity visibility

Question IDs can contain printed task text. Own-learner identity reads and
operation discovery therefore require release of the **selected exact revision**
on a guardian-origin source attempt. An unrelated revision or another attempt's
release is insufficient. Ordinary own-origin IDs remain available for legitimate
current-work marking and corrections without exposing withheld grades/feedback.

Correction ancestry is checked completely under the same tenant, learner,
activity and practice episode. Each guardian-origin ancestor must have an exact
released revision publishing the compatible immutable ID set before a descendant
can expose those semantic IDs. Matching published ID sets preserve already public
historical snapshots after a later private head, without aliases or rewritten IDs.
Missing, corrupt or cyclic ancestry fails closed; there is no depth cutoff that
silently skips earlier source guards. Current descendant release never grants
rights to a hidden ancestor.

The same boundary governs child correction capture, timeline payloads and delivery
acknowledgments, including legacy/trusted-produced descendants. Raw provisional
revision writes/returns cannot probe or replay guardian-origin private content;
authorized guardians retain processing/history access, and own-origin correction
marking remains supported once ancestral source identity is published. Schema,
ID collision/remapping rules and immutable stored history remain unchanged.

The offered marking schema mirrors the assessment validator: assessed results use
`markingCertainty` clear/unknown; `uncertain` marking requires `unassessed`, an
allowed non-none reason and both point fields null. This is not a conversion of
provider output: contradictory results remain refused. Mapping certainty remains
independent. Visible but overwritten/ambiguous responses can stay unassessed while
other clearly visible questions are assessed in the same valid proposal.

### Observed assessment layout

Optional `WorkbookAssessment.layout` version 1 describes observed sections in source
order and zero-based row/column question placements. It is advisory, with fixed
`provenance: 'observed'`; it never establishes identity or verified geometry.
Sections reference a retained source asset and a physical one-based observed page,
or null when unknown. A whole-file PDF anchor may support an observed page within
its retained page count while keeping its original anchor page null. Every placed
question must anchor the section's exact source. Multiple question IDs may share a
cell. When every placement in a cell has an explicit `part`, sort by part then
original question array index for ties. If any placement in that cell omits
`part`, the whole cell follows original question array order. Partial placement is valid. Missing `readingOrder` preserves original
question order for a flattened display.

The browser-safe `normalizeWorkbookObservedLayout` copies only bounded known
fields: at most 32 sections and 200 placements, 1–8 columns, rows 0–199, parts
0–31, section IDs up to 64 characters and labels up to 200. Duplicate section IDs
or question placements, invalid source/page/placement references and malformed
metadata discard the complete optional layout and retain `layoutOmission: 'invalid'`.
Valid answers and normal assessment validation remain independent. Owning analysis
and guardian writes both normalize against the current capture's source hashes;
a correction cannot inherit a previous capture's source layout. Default guardian
copies retain valid layout and safe omission markers. Bodies remain immutable JSON
inside existing revision privacy and exact release boundaries; no migration or
additional learner visibility is introduced.

Focused shared SQLite/PostgreSQL cases live in
`src/__tests__/workbook-layout-workflows.ts`, with SQLite in
`workbook-layout-service.test.ts` and isolated PostgreSQL in
`workbook-layout.optional.test.ts`. Pure bounds/reference cases are in
`workbook-layout.test.ts`. Integration runs the PostgreSQL wrapper under its
existing isolated database lifecycle.

Generation carries optional `layout` as advisory JSON so malformed presentation
cannot make valid question answers fail the generic schema. Its described wire
shape uses original evidence IDs; the bridge maps those IDs to retained assets
and then calls the strict owner normalizer. Within existing transport/JSON resource
limits, wrong types, unknown versions and conflicting metadata are omitted with
only the safe marker, while answers retain their normal strict validation. Layout
never establishes a question ID, a source authorization or a verified region.


### Same-capture reread context

`getWorkbookQuestionContext` returns authorized canonical `{id,prompt}` only
from the exact current attempt's identity revision. Generation preserves those
strings verbatim for the existing strict same-capture prompt invariant, while
rereading learner responses and any observed layout from current evidence. This
context is not an answer key or authority for answers. A correction without its
own revision receives predecessor IDs only; predecessor prompts are never copied.
Exact source/revision and full correction-ancestry visibility apply to both paths,
including own-learner reads. No historical rows are rewritten and absent layout
remains valid. `getWorkbookQuestionIdentity` remains the IDs-only public API.

Canonical prompts follow ordinary assessment payload visibility, including
captured review policy and exact guardian revision release even for learner-owned
sources; source/ancestry authorization alone does not publish guardian edits.
For ingestion callbacks only, the engine supplies current `analysisRevision` from
its owned item row. Context selection ignores AI materialized by that exact
current-attempt revision, so preserving a proposal does not invalidate its own
completed snapshot or preview. It never ignores guardian decisions, predecessor
revisions or another interpretation. Direct reads omit this engine pin and retain
normal current revision visibility; browser/upload fields cannot supply the pin.

### Observed answer-region overlays

Optional `answerRegions` version1/provenance observed/coordinateSpace
`display-oriented` carries one approximate rect `[x,y,width,height]` per question,
with exact retained asset/page1 and observationId. Rects are normalized to the
whole EXIF-oriented image; they never change question IDs, grading, anchors or
layout, and never claim verified geometry. Images only in this version; PDFs or
unknown positions omit regions. Direct malformed metadata is omitted with safe
`answerRegionsOmission: invalid`; marking/layout survive independently.

Vision catalogs originate in the existing opt-in extraction call. Generation
references exact evidence/observation IDs, never supplies coordinates. The bridge
copies catalog rectangles from the extraction-pinned configuration with matching
source hash. Guardian copies retain them; correction sources must match current
anchors. Existing exact release and ancestry privacy apply to the complete body.
