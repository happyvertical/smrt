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
  timeline, review, release and completion contract.
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

Learner-facing reads (`listLessonMaterials`/`listCourseMaterials` with a learner
actor, tutor context, learner printable signing) return only `audience:
'learner'` rows whose role is not guardian-only. Guardian-only material, keys,
rubrics, notes and storage URIs never reach a learner. A guardian may change a
row's audience within the role's bounds; the change is a new row version through
the owning service, never a raw write.

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
| `WorkbookWorkflowRequiredError`, `assertNonWorkbookSubmissionScope` | removed: every lesson uses the one pipeline |
| `Workbook`, `WorkbookWorkFiling` | removed (`Course` book identity, `LessonWorkFiling`) |

DTO fields: `workbookKey`/`edition`/`title` on activity views become
`courseId`, `bookKey`, `bookEdition`, `courseTitle`, plus `lessonPage`;
`filing.workbookId` becomes `filing.placement`.

## Migration

`migrateWorkbooksToCourses(db)` (exported, host-run after the schema migration,
idempotent, transactional). It reads the retired `workbooks`,
`workbook_work_filings` and `workbook_context_revisions` tables when they exist
and is a no-op otherwise.

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
4. Legacy filings become `LessonWorkFiling` rows with the same IDs, placing the
   work in the canonical course and (when the legacy filing named a canonical
   activity) on that activity's lesson.
5. Context revisions are copied into `book_context_revisions` with the same IDs
   and `courseId` = canonical course.

Each step skips rows already migrated (same IDs or existing book key), so a
re-run changes nothing. Retired tables are left in place for audit; dropping
them is a later deliberate operation.
