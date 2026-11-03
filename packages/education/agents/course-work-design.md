# Course work design (SMRT #4614, folds in #4613)

Phase 1 of hearthed.org#125. Breaking changes are allowed: Hearth is the only
consumer. This note is the design record; the current contracts live in
[lesson work](lesson-work-service.md), [photo intake](photo-intake.md),
[submission](submission-service.md) and [lesson materials](lesson-materials.md).

## Model

- **Course absorbs Workbook.** `Course` gains optional book identity: `bookKey`
  (`''` = not a book), `bookEdition`, and the course work policy
  `workReviewRequired` (default true) / `workPolicyVersion` (default 1). A
  book key requires an owning tenant and is unique per family (one course per
  tenant per book key, enforced at save). `Workbook` and its learner-scoped
  rows are retired; the model is deleted.
- **Lessons have pages.** `LessonPage` (tenant, lesson, `pageKey`, `label`,
  `sortOrder`, nullable `sourceAssetId` + `sourcePageNumber`) is family-scoped
  course structure, unique per (tenant, lesson, page key). Photo identification
  resolves book key → course, page key → lesson page; a book page without a
  lesson gets a one-page Worksheet lesson in the book course.
- **One work pipeline.** Every hand-in on every lesson is a `LessonActivity`
  (one per learner enrollment and lesson) with immutable `WorkAttempt`s,
  revisioned `WorkAssessmentRevision`s, `WorkFeedbackRelease`s,
  `WorkFeedbackDelivery`s and `WorkCompletionDecision`s. `SubmissionService`
  capture and correction write the activity and attempt in the same
  transaction, so ordinary lessons, book pages and loose photos share one
  timeline, review, release and completion contract. Completion differs by
  kind: on an ordinary lesson the guardian grade records the completion
  decision on the graded attempt (and the learner sees the grade); book and
  loose-page work is release-gated and completes only by the parent decision,
  so it stays on `LessonWorkService` (generic capture refuses it with
  `LessonWorkWorkflowRequiredError`).
- **Per-page versions (#4613).** `SubmissionAsset.pageKey` names the lesson page
  a file belongs to (default `p<n>` by position). A correction may carry only
  the pages it replaces; earlier pages stay at their version. Attempt views
  expose `pages: [{pageKey, versions:[{submissionId, attemptId, assetId}]}]`
  folded over the correction chain. Grades stay bound to their submission.
- **Filing places work.** `LessonWorkFiling` (new table) appends a placement for
  unfiled work: target course, the learner's enrollment, lesson and lesson page.
  A book course appends a Worksheet lesson when no lesson has the page key; an
  authored course needs the lesson to exist (the host appends it first with
  `CourseAuthoringService.appendLesson`, which owns revisions and releases).
  Placement is the activity's effective location: lists by course include it,
  the unfiled list drops it, and the target lesson's progress follows the
  activity's completion. Activity, attempt, submission and assessment IDs never
  move. Replays are no-ops; a changed replay or stale head conflicts.
- **Material roles and audience.** `LessonAssetRelationship` is `teacher-guide`,
  `slides`, `learner-pages`, `assessment`, `assessment-guidance`, `handout`,
  `printable`, `answer-key`, `video`, `attachment`. Each `LessonAsset` carries
  `audience: 'learner' | 'guardian'` with a per-role default
  (`LESSON_ASSET_DEFAULT_AUDIENCE`): guardian for teacher-guide, slides,
  assessment-guidance, answer-key; learner otherwise. `answer-key` and
  `assessment-guidance` are always guardian. `CourseAsset` holds course-level
  materials with the same roles and audience.
- **External videos.** A `video` material may be an external reference instead
  of a stored asset: `externalProvider: 'youtube'`, an 11-character video id
  (from an id or an allowlisted youtube.com / youtu.be URL), a title and a step
  order. It is never downloaded; no Asset row exists for it.

## Audience rule

Learner-facing reads (`listLessonMaterials`/`listCourseMaterials` for the learner
themself, `signLessonMaterial`/`signCourseMaterial`, and every catalog projection
without answer keys) return only rows whose effective audience is `learner`.
Guardian-only material, keys, rubrics, notes and storage URIs never reach a
learner. A guardian may change a family-owned row's audience within the role's
bounds through `setMaterialAudience`; authored courses change it through course
authoring (`CourseMaterialInput.audience`) and the next release.

## Renames (public API)

Storage names that are persisted identifiers keep their value: tables
`workbook_activities`, `workbook_attempts`, `workbook_assessment_revisions`,
`workbook_feedback_releases`, `workbook_feedback_deliveries`,
`workbook_completion_decisions`, `workbook_photo_*`, and the ingestion
handler/operation IDs captured in receipt ceilings. Renaming them would copy
append-only history and re-point group-sharing foreign keys for no behaviour
change. The photo-intake models (`WorkbookPhoto*`) keep their class names for
the same reason (their names derive persisted operation IDs and grants).

| Before | After |
| --- | --- |
| `WorkbookService` | `LessonWorkService` |
| `WorkbookActivity` / `WorkbookActivityView` | `LessonActivity` / `LessonActivityView` |
| `WorkbookAttempt`, `WorkbookAssessmentRevision`, `WorkbookFeedbackRelease`, `WorkbookFeedbackDelivery`, `WorkbookCompletionDecision` | `WorkAttempt`, `WorkAssessmentRevision`, `WorkFeedbackRelease`, `WorkFeedbackDelivery`, `WorkCompletionDecision` |
| `WorkbookAssessment`, `WorkbookQuestion`, … contracts, `WORKBOOK_MATH_VOCABULARY` | `WorkAssessment`, `WorkQuestion`, …, `WORK_MATH_VOCABULARY` |
| `resolveWorkbookActivity({workbookKey,title,edition,pageKey,pageLabel})` | `resolveBookPageActivity({bookKey,title,edition,pageKey,pageLabel})` |
| `getWorkbookActivity`, `listWorkbookActivities` | `getLessonActivity`, `listLessonActivities({courseId?, filing?})` |
| `setWorkbookFeedbackPolicy({activityId,…})` | `setCourseWorkPolicy({courseId,expectedPolicyVersion,reviewRequired})` |
| `captureWorkbookWork` | `captureLessonWork` (pages may carry `pageKey`) |
| `recordWorkbookAnalysis`, `reviewWorkbookAssessment`, `releaseWorkbookFeedback`, `acknowledgeWorkbookFeedbackDelivery`, `completeWorkbookActivity`, `getWorkbookTimeline` | `recordWorkAnalysis`, `reviewWorkAssessment`, `releaseWorkFeedback`, `acknowledgeWorkFeedbackDelivery`, `completeLessonActivity`, `getWorkTimeline` |
| `getWorkbook{AttemptBySubmission,PreservationState,SourceAnchors,QuestionIdentity,QuestionContext}` | `getWork…` |
| `fileWorkbookWork({workbookId \| newWorkbook, canonicalActivityId})` | `fileLessonWork({courseId \| newBook, lessonId?, pageKey?, pageLabel?})` |
| `listWorkbookPhotoWorkbooks` | `listPhotoBookCourses` |
| `WorkbookContextRevision` (`workbookId`) | `BookContextRevision` (`courseId`), table `book_context_revisions` |
| `WorkbookWorkflowRequiredError`, `assertNonWorkbookSubmissionScope` | `LessonWorkWorkflowRequiredError`, `assertOrdinarySubmissionScope` (book and loose-page work only) |
| `WorkbookPhotoIntakeView.workbookId` | `bookCourseId` |
| `Workbook`, `WorkbookWorkFiling` | removed (`Course` book identity, `LessonWorkFiling`) |

DTO fields: `workbookKey`/`edition`/`title` on activity views become
`courseId`, `courseTitle`, `bookKey`, `bookEdition`, `lessonTitle` and `pages`
(the effective placement; `enrollmentId`/`lessonId` stay the capture routing);
`filing.workbookId`/`canonicalActivityId` become `filing.placement`. Submission
pages and `WorkAttemptView` gain `pageKey`/`pages`.

## Migration

`migrateWorkbooksToCourses(db)` (exported, host-run after the schema migration,
idempotent, transactional). It reads the retired `workbooks`,
`workbook_work_filings` and `workbook_context_revisions` tables when they exist
and is a no-op otherwise. It first drops the retired unique index
`workbook_activities_tenant_id_workbook_id_idx` (tenant, workbook, page key): new
activities carry no book link and PostgreSQL's NULLS NOT DISTINCT would make them
collide. The schema diff leaves the retired `workbook_id`/`page_key`/`page_label`
columns as reported orphans; drop them later with `--drop-columns`.
The comparer's "rename data pending" note for `workbook_activities.context`
(it guesses the orphan `page_key`/`page_label` data was renamed) is report-only
and must not be acted on. `LessonActivity` declares `onDelete: 'NO ACTION'` on
`enrollmentId`/`lessonId`: as its new natural key they would otherwise default to
CASCADE and differ from the deployed foreign keys, which SQLite can only change
by a table rebuild (`lesson-work-schema-contract.test.ts`). The opt-in
`course-work-real-data.optional.test.ts` (`HEARTH_LEGACY_DB=<copy>`) runs the
schema step, the data step and new hand-ins on a copy of a real database.

1. Group workbooks by (tenant, workbook key). The canonical course is the
   earliest (created_at, id) learner's `physical-workbook` scaffold course; it
   receives `bookKey`, `bookEdition`, title and the strictest policy (review
   required if any duplicate required it; policy version = max).
2. Each other learner's scaffold course is merged: its sections and its
   enrollment are re-pointed to the canonical course, and the emptied course is
   archived with `sourceKey: 'merged-book'`, `sourceRef: <canonical id>`.
   Learner history rows (progress, submissions, attempts, grades) are not
   rewritten; their lessons move with their section.
3. Every legacy activity's page key/label becomes a `LessonPage` on its lesson.
4. Legacy filings become `LessonWorkFiling` rows with the same IDs, predecessors
   first, placing the work in the canonical course: on the named canonical
   activity's lesson and page, else on a new `Captured work` lesson. The target
   lesson's progress row is created from the work's completion.
5. Context revisions are copied into `book_context_revisions` with the same IDs
   and `courseId` = canonical course.

Each step skips rows already migrated (same IDs or existing book key), so a
re-run changes nothing. Retired tables are left in place for audit; dropping
them is a later deliberate operation.
