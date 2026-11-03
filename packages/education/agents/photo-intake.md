# Photo-first book page intake

`WorkbookPhotoService` extends `LessonWorkService` with the same constructor,
transaction executor, actor/tenant checks, private storage and rollback ledger.
Import server integration from `@happyvertical/smrt-education/ingestion`.
Apply manifest migrations for `WorkbookPhotoIntake`, `WorkbookPhotoAsset`,
`WorkbookPhotoDecision` and `BookContextRevision` before deploying. The photo
models keep their `Workbook*` names: they derive the persisted ingestion operation
IDs and grants captured in receipt ceilings. The book they identify is a course
with book identity ([course work](course-work-design.md)). There is
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
`listPhotoBookCourses(request)` returns the family's book courses (including
cover-only books) for the provider and guardian picker, with publisher/ISBN context
from this learner's own decisions. Provider candidates are `Course` targets; the
wire candidate id (`workbookId`) is the course id and its `workbookKey` the book key. A printed lesson identity supplies one stable activity key;
multiple page files may belong to that same lesson. Page number alone cannot
automatically establish lesson identity.

A guardian may call `resolveWorkbookPhotoIntake({...request,intakeId,requestKey,
identification})` after upload. It requires planning authority and appends a new
decision. Stable request-key retries replay; changed retries conflict. Covers and
references create/reuse the family's book course and append contextual metadata
(`BookContextRevision`) only: no Lesson, enrollment, progress, attempt, Grade or
concept observations. Existing book title/edition identity never changes; context versions retain original
metadata and source receipt identity. A captured intake cannot be retargeted.

## Existing marking pipeline

`captureWorkbookPhotoIntake({...request,intakeId,requestKey,assistance?,
previousSubmissionId?,completedWork?})` copies the retained originals through
`captureLessonWork` and returns its immutable attempt. Blank or unknown work
requires explicit `completedWork:true`; no blank exercise is automatically marked
as unanswered learner work. Corrections require the explicit current predecessor
and preserve the existing practice episode. Existing attempts reject automatic
replacement; provider classification cannot silently turn a new photo into a
correction.

After capture, configure the existing `educationIntakeHandlers` with the returned
submission ID, `view.activity.id`, and authoritative activity enrollment ID.
Queue `queueEducationExtraction(ingestion,view.itemId,configuration,submissionId)`
on the **same learner-scoped receipt**, process normally, then use
`preserveWorkIntakeAnalysis`. That bridge already verifies exact education
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
`WorkFeedbackRelease` on that submission's exact `WorkAttempt` releases
its source. Another attempt or context-only page cannot borrow that release.

The base `SubmissionService` applies this policy too: own learners receive no
pages, notes, Grade/feedback or grade-derived status before release, and signing
a guessed source asset is denied. The DTO exposes `awaitingParentRelease:true`
for an own learner awaiting release, and `sourceRequiresParentRelease:true` to
all authorized actors for guardian-origin material. The latter remains true
after release: every new derived revision still needs its own explicit release.
`WorkAttemptView.reviewRequired` and persisted capture policy snapshots
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

## Existing candidate identification

The provider's `workbookId` selects an exact authorized candidate (a book course id); it does not replace the
required `identification.workbook` contract. Copy that candidate's `workbookKey`,
`title` and `edition` into the required object. Those are catalog identity fields,
not invented IDs or claims about what is printed on the new photograph.
`identityEvidence` quotes only current visible material. A unique current
title/edition may match retained publisher provenance without publisher/ISBN
being reprinted. Conflicting identity, duplicate candidates and title-only
matching remain pending; malformed model output is never repaired automatically.

## Exact receipt authorization

Processing and retries resolve `context.itemId` through the service-owned
`getWorkbookPhotoIntakeByItem` lookup, scoped to the current tenant and learner
on the supplied executor. It delegates to the same current actor and private
source/release checks as the intake-ID getter. The inbox list remains capped at
1,000 rows for display; that pagination window is never an authorization or
lifetime receipt limit.

Hosts may opt into `listWorkbookPhotoIntakes(request, { newestFirst: true })`
for a current inbox. Default ordering remains unchanged and both orders keep the
1,000-row display bound and the same per-receipt visibility checks. Exact selected
receipt reads remain independent of either display window.

## Marking before filing

Completed learner work does not require a printed lesson number or workbook
identity. Identification `kind:'work', workState:'completed'` deliberately omits
`workbook`, `activity` and `workbookId`. Its confidence concerns observable learner
completion/material kind, independently of bibliographic identity. Printed worked
examples, answer keys, blank pages and uncertain material are not completed learner
work. `kind:'lesson'` retains the existing strict printed identity contract.

Confident work preservation creates one receipt-bound **unfiled** work unit.
`processWorkbookPhotoAnalysis` captures it and returns the existing
`capture/assessmentRequired` result. Queue the normal assessment stage on that
same receipt, submission and returned activity/enrollment IDs; do not re-upload or
create another receipt. Visible responses can be assessed while illegible or
ambiguous responses remain unassessed. The extraction observation contract keeps
printed examples separate from learner marks and reports matching endpoints only
when observed. Adopt it with a new extraction configuration revision.

The internal private Course/Enrollment/Worksheet are routing records, not a claim
about a canonical book or lesson. Only `captureKind:'unfiled'` carries an exact owned
`photoIntakeId`; all identified activity invariants remain. No book is invented.
Activity DTO `filing.state` is `unfiled`, `filed` or `identified`; unfiled work has
`filing.placement: null`, empty course/book fields and the `Captured work` label.
`listLessonActivities` includes these work units. Exact
`getWorkbookPhotoTimeline({...request,intakeId,limit?,cursor?,revisionId?})`
returns existing authorized feedback/history; the normal activity timeline also
works. `getLessonActivity` refreshes exact filing presentation without loading
history. The receipt view refreshes filing rather than replaying its old label.

Guardian `fileLessonWork` places unfiled work in a course (an existing book course,
a new book, or another enrolled course), matching or appending the lesson page; see
[lesson work filing](lesson-work-service.md#identity-independent-work-and-filing).
The work leaves the unfiled list at once and its target lesson follows its
completion. Filing does not move or recreate activity, submission, attempt,
assessment, release, source or correction episode IDs, cannot change captured
review policy, create a Grade, duplicate concept evidence, or release
guardian-origin material. Future corrections continue against the original
work-unit ID and explicit current predecessor and snapshot the placed course's
policy. Identified captures cannot be refiled.

## Exact cover context for header selection

`getWorkbookPhotoIntake` adds nullable `bookCourseId`, loaded from the latest
retained resolution's exact BookContextRevision under the same tenant/learner
and decision ID. Pending/uncertain or unfiled-work resolution returns null; this is
independent of a later activity filing. It never guesses from title or an inbox
list. Existing guardian-origin receipt privacy still applies before lookup.

Header cover camera/upload uses the normal receive/process photo flow. A confident
cover resolves book/context only, with no attempt, lesson or Grade. Read that exact
intake, then let the guardian explicitly choose `fileLessonWork({courseId: bookCourseId,...})`.
An uncertain cover can use the existing guardian `resolveWorkbookPhotoIntake` with
manual cover metadata, followed by the same exact getter and explicit filing.
Neither cover identification nor context alone publishes learner source/feedback.
