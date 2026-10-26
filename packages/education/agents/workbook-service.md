# Physical workbook contract

`WorkbookService` extends `SubmissionService` with the same actor-bound authorization,
private asset runtime, transaction executor and guardian Grade boundary. It is an
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
service uses [0,0,1,1] and explicit source/page grounding with limitations. Only
pinned extraction page annotations can justify a PDF page; missing localization
remains a complete original-file anchor, not a claim about page 1. Fictitious PDF
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
Known question IDs and prompts are pinned across reanalysis/corrections. The public
`getWorkbookQuestionIdentity` supplies prompt/ID context without answers or marks;
handlers use it to request the same IDs and explicit not-present rows on rescans.
A different page/question requires explicit new activity identity, never AI retargeting.

`captureEducationIntake` accepts optional `workbookActivityId`/`assistance` when its
service is WorkbookService. It preserves the existing return SubmissionView and
binds the workbook attempt/policy before the host queues processing.
`educationIntakeHandlers({workbookActivityId,...})` advertises a bounded JSON question
schema to real ingestion generation. Assessed results require reason none;
unassessed reasons require null points. Per-question outcomes must agree with
points. Model aggregate scores/narratives are not requested or trusted: exact
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
hash/page-support metadata from the completed extraction before it ceases to be
the current analysis. This uses public ingestion APIs and is pinned by its
configuration digest; absent metadata yields honest source-only grounding.

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

## Validation and limits

`src/__tests__/workbook-workflows.ts` is the shared SQLite/PostgreSQL contract suite;
`workbook-service.test.ts` runs SQLite, and `workbook.optional.test.ts` runs against
an available isolated PostgreSQL database. Workers never provision service stacks.
Run package test/typecheck/build; the integration owner runs test:postgres and the
integrated review. Synthetic provider DTO tests establish transfer integrity, not
real handwriting accuracy. Actual provider/sample and app restart/retention
acceptance remain separate integration evidence. Family deletion/export/backup
policy and automatic lesson generation are not implemented by this milestone.
