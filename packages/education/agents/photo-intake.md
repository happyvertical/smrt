# Photo-first workbook intake

`WorkbookPhotoService` extends `WorkbookService` with the same constructor,
transaction executor, actor/tenant checks, private storage and rollback ledger.
Import server integration from `@happyvertical/smrt-education/ingestion`.
Apply manifest migrations for `WorkbookPhotoIntake`, `WorkbookPhotoAsset`,
`WorkbookPhotoDecision` and `WorkbookContextRevision` before deploying. There is
no runtime schema creation and these models expose no generated operations. Each
concrete table declares its own tenant/learner fields; a custom abstract model
base does not supply persisted columns to independent manifest tables.

## Receipt before assignment

Construct the service and `IngestionService` from one authenticated server session.
Use `scope.confidentialScopeId = request.learnerId`, not an enrollment or model
inference. `authorizePhotoIntake(request)` authorizes a learner's own upload or a
currently authorized guardian before `receiveWorkbookPhotoIntake({ingestion,
scope,workbooks,request,receive})` calls ingestion. Its result is `{receipt,intake}`;
`intake:null` means no successful durable receipt. `retainWorkbookPhotoReceipt`
repairs an interrupted education copy from an existing authorized receipt.

The immutable education receipt retains the original bytes as private Assets
through the sole `WorkbookPhotoAsset` owner join, preserving ordered SHA-256
hashes. Copy retries reject changed bytes, filenames, media types or learner
ownership. Storage uses the inherited fresh-file compensation ledger; borrowed
host executors cannot perform file writes. Provider failure does not delete the
receipt or originals. `getWorkbookPhotoIntake`, `listWorkbookPhotoIntakes` and
`readWorkbookPhotoOriginal` reauthorize exact ownership independently of scratch
retention. A learner cannot list/read guardian-uploaded pending or context-only
material. Guardian-origin lesson source remains private until an explicit
feedback release on its exact captured attempt, regardless of automatic material
classification or the workbook provisional-feedback setting. Guardian reads remain
subject to the current relationship and grants. Child-owned uploads retain the
normal learner boundary.

## Provider identification and human decisions

Configure `workbookPhotoIntakeHandlers({workbooks,request})` and
`workbookPhotoIntakeTargetResolver({workbooks,request})` on ingestion's execution
catalog, and the normal proposal generator/read configuration. Handler
`@happyvertical/smrt-education:identify-workbook-photo` uses
`@happyvertical/smrt-education:WorkbookPhotoIntake:get@1` and
`workbookphotointakes.read`. This operation classifies only; applying it never
creates a Grade. Keep `requireReview:true`. Candidate freshness checks use the
supplied executor and the exact authorized workbook/context digest.

The initial immutable captured ceiling must include all intended later stages
and a provisioned stable execution principal; for marking, include the existing
review-submission/Grade operation as well. Current guardian authorization still
controls every Grade. Never widen the receipt ceiling after upload or create a
second receipt to evade that boundary.

Queue with `queueEducationExtraction`, process extraction/interpretation with
`processEducationAnalysis`, then call `preserveWorkbookPhotoIdentification`.
Alternatively `processWorkbookPhotoAnalysis` combines processing, preservation
and capture of a confidently resolved **completed** lesson. It returns
`{processing,intake,capture,assessmentRequired}`. The provider runs outside the
education transaction. Preservation reads the current public immutable ingestion
snapshot, exact offered schema and original hashes; it retains analysis IDs,
revision, digests and provider/configuration provenance in append-only decisions.
Unavailable, failed, stale, malformed and ambiguous results leave durable intake
pending. A provider needs-review outcome, alternatives or splits never authorize
automatic resolution; its original proposal remains inspectable. Literal page
numbers cannot establish lesson identity. Authorization/integrity/database failures still throw.

Provider output distinguishes lesson, cover, reference (including contents and
answer keys), and uncertain material, plus blank/completed/unknown work state.
Automatic book identity requires a printed ISBN or complete printed
publisher/title/edition quotations. Title alone never merges. An existing book may instead match exact current printed title/edition to one
authorized contextual record with retained publisher provenance; that publisher
is context, never a fabricated current quotation. Conflicting or ambiguous
matches stay pending. Provider
candidates contain book metadata only, never reference text or answer keys.
`listWorkbookPhotoWorkbooks(request)` includes cover-only books for the provider
and guardian picker. A printed lesson identity supplies one stable activity key;
multiple page files may belong to that same lesson. Page number alone cannot
automatically establish lesson identity.

A guardian may call `resolveWorkbookPhotoIntake({...request,intakeId,requestKey,
identification})` after upload. It requires planning authority and appends a new
decision. Stable request-key retries replay; changed retries conflict. Covers and
references create/reuse the Workbook and append contextual metadata only: no
Course, Lesson, progress, attempt, Grade or concept observations. Existing
Workbook title/edition identity never changes; context versions retain original
metadata and source receipt identity. A captured intake cannot be retargeted.

## Existing marking pipeline

`captureWorkbookPhotoIntake({...request,intakeId,requestKey,assistance?,
previousSubmissionId?,completedWork?})` copies the retained originals through
`captureWorkbookWork` and returns its immutable attempt. Blank or unknown work
requires explicit `completedWork:true`; no blank exercise is automatically marked
as unanswered learner work. Corrections require the explicit current predecessor
and preserve the existing practice episode. Existing attempts reject automatic
replacement; provider classification cannot silently turn a new photo into a
correction.

After capture, configure the existing `educationIntakeHandlers` with the returned
submission ID, `view.activity.id`, and authoritative activity enrollment ID.
Queue `queueEducationExtraction(ingestion,view.itemId,configuration,submissionId)`
on the **same learner-scoped receipt**, process normally, then use
`preserveWorkbookIntakeAnalysis`. That bridge already verifies exact education
ownership and source binding independently of the receipt's confidential scope.
Guardian Grade/release policy and immutable assessment history are unchanged.

## Verification matrix

`src/__tests__/photo-intake-workflows.ts` runs on SQLite and available PostgreSQL
(`photo-intake.test.ts` / `photo-intake.optional.test.ts`).
`photo-intake-manifest.test.ts` separately pins all concrete ownership/provenance
columns and UUID/FK definitions in the generated structured manifest. It covers actor/resource
ownership and active context, private originals, sibling/foreign asset denial,
retry conflicts, concurrent deduplication, rollback and borrowed executor denial,
cover-only context and immutable identity, ambiguous titles, source integrity,
blank work intent, multi-page capture, real ingestion generation for cover then
lesson, provider failure, and guardian-only pending/reference originals. The same
transaction executor is used for authorization and mutations. Real provider
handwriting accuracy and deployment worker isolation remain host acceptance.

Run package test/typecheck/build; integration owns PostgreSQL provisioning and
full-suite validation. Workers never start containers. This is additive feature
work; a base regression run is N/A because no pre-activity capture API existed.

## Guardian-origin source privacy

The immutable photo receipt actor, compared with the persisted learner user,
determines source origin. Classification as a lesson does not grant learner
access. `Submission.intakeItemId` joins the exact tenant/learner receipt; only a
`WorkbookFeedbackRelease` on that submission's exact `WorkbookAttempt` releases
its source. Another attempt or context-only page cannot borrow that release.

The base `SubmissionService` applies this policy too: own learners receive no
pages, notes, Grade/feedback or grade-derived status before release, and signing
a guessed source asset is denied. The DTO exposes `awaitingParentRelease:true`
for an own learner awaiting release, and `sourceRequiresParentRelease:true` to
all authorized actors for guardian-origin material. The latter remains true
after release: every new derived revision still needs its own explicit release.
`WorkbookAttemptView.reviewRequired` and persisted capture policy snapshots
retain their historical workbook setting; combine that setting with
`submission.sourceRequiresParentRelease` when describing effective visibility. Workbook timeline and
feedback delivery acknowledgment require exact revision release for this source,
even when the general workbook policy permits provisional AI feedback.

Existing hosts without photo schema retain ordinary submission behavior through
optional table-existence checks; no application schema is created at runtime.
The shared SQLite/PostgreSQL privacy case covers guardian-origin mistaken lesson
capture, policy off, automatic AI and guardian assessment before release, direct
base submission reads/signing, exact release, later unreleased reanalysis and a
different attempt that stays private. Existing own-learner capture cases remain
readable, and legacy submission/workbook suites protect consumers without photo
tables.
