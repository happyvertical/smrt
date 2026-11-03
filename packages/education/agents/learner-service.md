# Learner service boundary

`Learner`, `Curriculum`, `Enrollment`, and `LessonProgress` require an exact
owning tenant. Their generated API, CLI, MCP, and AI operations are closed.
The corresponding collections and model saves are trusted server persistence
APIs, not request handlers. Hosts must not wrap them in generic learner CRUD.

## Identity and authority

Provision a Person Profile, a linked User, and an active Membership before
creating a Learner with explicit `tenantId`, `userId`, and `profileId`. User
email is optional. Learner identity cannot be reassigned after creation.
Guardianship is a directed `ProfileRelationship`, not a Learner `parentId`.
The shared Tenant has no family discriminator: “family” means a tenant that
the host has provisioned and authorized for this purpose.

Construct `LearnerService(db, authorizeLearner, authorizeCatalog)` with one
root database executor and trusted server-side authorizers. Enable tenancy
and establish `withTenant({ tenantId, userId }, callback)` from authenticated
credentials. Every request must match that active actor and tenant exactly;
missing context, spoofed identifiers, and super-admin bypass contexts fail.
Both the actor and learner must hold active memberships in that exact tenant.
A learner's User must still link to the learner's Person Profile.

For a different actor, supply `guardianRelationshipId`. The service checks
that this relationship is owned by the active tenant and directed from the
actor's User Profile to the learner's Profile. `authorizeLearner` receives
`own`, `action`, and the verified `relationshipTypeId`; the host must check
that the type represents guardianship, its terms are effective, and that
its permission policy allows the action. An arbitrary relationship is not a
guardian grant. Missing relationships and host denials/exceptions fail closed.
The authorizer also receives `executor`, the service's active database
executor. Host policy reads, including relationship and revocation checks, must
use that executor so they share a `withTransaction` or `withExecutor` boundary.
Same-tenant membership alone never grants sibling access.

## Supported workflow

- `getLearnerSetupStatus({ tenantId, actorUserId, learnerUserId })` is a
  host-authorized onboarding probe for an active tenant member. It returns only
  `{ needsSetup }`; it neither returns learner or relationship data nor grants
  relationships. The host authorizer receives `education.learner.setup`, the
  target user id, and the active executor. `provisionLearner` remains the write
  path and still requires a directed guardian relationship.
- `getLearner` returns authorized learner metadata and parsed settings.
- `createCurriculum` creates a **planned** curriculum for an authorized guardian.
  A learner cannot plan their own curriculum. Title is required.
- `enroll` requires that guardian authority and a matching tenant curriculum.
  It returns the existing enrollment for the same curriculum/course unchanged.
  A delegated agent may enroll, only when the host opts in: construct
  `LearnerService(db, authorize, authorizeCatalog, { verifyDelegation })` where
  `verifyDelegation(executor, { tenantId, actorUserId, delegatingGuardianUserId,
  delegationId, learnerId, courseId? }) => boolean | { allowed, reason?, code? }` runs on the
  current executor. Without the port, or if it denies or throws, `enroll` refuses with
  `LearnerAuthorizationError` before the learner authorizer and before any write. Supply
  `delegatingGuardianUserId` and `delegationId` (both or neither, 1-200 printable characters,
  guardian not the agent). After the port, the service re-checks the DELEGATING guardian's
  active membership and `guardianRelationshipId` (that guardian's profile to the learner, same
  tenant) and the agent's active membership. The authorizer gets `education.learner.plan`,
  `own: false`, `delegated: true`, `relationshipTypeId` undefined (so a legacy
  `relationshipTypeId === guardian` rule denies), the guardian's type as
  `delegatingRelationshipTypeId`, `delegatingGuardianUserId` and `delegationId`, and decides.
  A new delegated enrollment appends one `EnrollmentAssignmentRecord` (`Enrollment` is
  unchanged). Only `enroll` and `createCurriculum` accept a delegation (on `LearnerService` itself; subclasses without
  the port refuse); every other operation ignores it, so the agent has no
  other learner authority. Catalog reads still use the agent as actor.
  `createCurriculum` accepts the same delegated actor (`operation: 'create-curriculum'`
  on the verifier request, `enroll` sends `'enroll'`), with identical verification, guardian
  relationship recheck, authorizer shape and stripping of caller authority keys; each new
  delegated curriculum appends one `CurriculumCreationRecord` (own table, `Curriculum` unchanged).
- `startLesson` allows the learner or authorized guardian to create their own
  enrollment's lesson progress in `in_progress`. It derives learner identity
  from the validated enrollment. Repeated starts return existing state without
  resetting counters, scores, completion, or timestamps. A `not_started` row
  (a put-back lesson) moves to `in_progress` again with its counters, score and
  first `startedAt` kept.
- `putBackLesson({ enrollmentId, lessonId })` takes `in_progress` work back to
  `not_started` for the learner or an authorized guardian under
  `education.progress.put-back` (the host decides; own is not blocked). The
  progress row keeps its one (enrollment, lesson) identity, so each change
  appends an immutable `LessonProgressTransition` (from, to, kind, actor,
  time) in the same transaction; restarting appends a `start` row when the
  table exists. Counters, score, submissions, grades, workbook and evidence
  rows are never touched. It returns `{ changed, progress }`: no progress or
  already `not_started` is an idempotent no-op. `submitted`, `needs_review`,
  `complete`, `skipped` (stored or workbook-projected) refuse with
  `LessonPutBackError` (`.status`); completion is undone only through guardian
  paths. A host without `lesson_progress_transitions` gets
  `LearnerHistoryUnavailableError` from put-back; other operations still run.
- `setEnrollmentStatus({ enrollmentId, status, policyBasis })` moves an
  enrollment along `ENROLLMENT_STATUS_TRANSITIONS`: planned→active,
  active→paused|dropped, paused→active|dropped. `completed` is reached only by
  the completion path; completed and dropped are final. The authorizer gets
  `education.enrollment.set-status` and decides whether a learner may act on
  their own enrollment. `policyBasis` (1-200 characters, no control characters,
  `requirePolicyBasis`) names the host setting relied on; it and the actor are
  appended to an immutable `EnrollmentStatusChange` with the change, as
  `pinEnrollment` records its basis. The first activation sets `startedAt`.
  The current status is an idempotent `{ changed: false }`; any other move
  throws `EnrollmentStatusTransitionError` (`.from`, `.to`). Progress,
  submissions and history never cascade. Bad input throws
  `LearnerValidationError`; a host without `enrollment_status_changes` gets
  `LearnerHistoryUnavailableError`.
- `completeOwnLesson({ enrollmentId, lessonId, policyBasis, evidence?: { submissionId } })`
  moves progress to `complete` (any lesson kind, `completedAt` set, a missing
  row created) under `education.progress.complete-own`; the host decides per
  setting and may allow a guardian too (own is not blocked). It appends an
  immutable `LessonCompletionRecord` (actor, `policyBasis`, prior status,
  optional evidence submission, at most one per progress) and a `complete`
  `LessonProgressTransition` when that optional table exists. `evidence`
  must be a non-rejected submission of the same tenant, learner, lesson and
  progress, else `LearnerAuthorizationError`. Counters, score and start time
  are untouched; no score is invented. Returns `{ changed, progress }`.
  Repeat rule: a lesson already completed through this path (a record exists)
  returns `{ changed: false }`; one complete any other way (guardian
  `attestLesson`/grade, workbook completion) throws `LessonAlreadyCompleteError`.
  Also `EnrollmentNotActiveError` (`.status`; only `active` enrollments),
  `LessonSkippedError`, `LessonWorkOwnedError` (a workbook lesson completes
  through its workbook decision), and `LearnerHistoryUnavailableError` without
  `lesson_completion_records`. Guardian `attestLesson` is unchanged.
- `setEnrollmentPace({ enrollmentId, pace: { lessonsPerWeek } | null, policyBasis })`
  sets or clears the enrollment's planned lessons per week under
  `education.enrollment.set-pace` (the host decides whether a learner may act
  on their own enrollment). `lessonsPerWeek` is a whole number from 1 to 14
  (`MIN_/MAX_LESSONS_PER_WEEK`), else `EnrollmentPaceError`. It is stored as the
  integer column `enrollments.pace_lessons_per_week` (`0` = no pace, like
  `targetMinutesPerWeek`) and surfaces as `EnrollmentView.pace` (`null` when
  unset). Each change appends an immutable `EnrollmentPaceChange` (actor,
  `policyBasis`, previous and new value, `0` = none); an unchanged pace is
  `{ changed: false }` with no row. Status and progress are untouched. A host
  without `enrollment_pace_changes` gets `LearnerHistoryUnavailableError`.
  Apply the additive migration (new column plus table) before deploying writes;
  reads of an un-migrated table report no pace.
- `setInterestTheme({ theme: { label, key? } | null, policyBasis })` stores the
  learner's interest theme under `education.learner.set-interest-theme`. The
  label is a short plain string (1-60 characters after whitespace is collapsed;
  control characters, `@`, `://` and `www.` are refused so it cannot carry
  contact details) and the optional key is lowercase `[a-z0-9-]` up to 40
  characters. The package ships no starter list: the host owns its keys
  (for Hearth `minecraft`, `roman`, `hockey`, `baseball`, `football`, `soccer`,
  `cars`) and family-added themes are free labels without a key. A guardian with
  an effective relationship may set any of their learners' themes; the learner
  may set their own when the host authorizer answers `own: true` as allowed;
  another learner's theme needs the actor's own guardian relationship, so a
  learner, sibling or stranger is refused by the same actor/tenant checks as
  every other operation. It is a skin for stories and examples only; it never
  changes an objective. Columns `learners.interest_theme_label` and
  `interest_theme_key` (additive; empty = none) hold the value and each change
  appends a `LearnerInterestThemeChange` (actor, `policyBasis`, previous and new
  value). An unchanged value is `{ changed: false }`; a bad value is
  `InterestThemeError`; a host without `learner_interest_theme_changes` gets
  `LearnerHistoryUnavailableError`. `getLearner` returns `interestTheme`
  (`{ label, key } | null`). Apply the additive migration before deploying.
- `nextLessons({ enrollmentId?, count? })`: `count` is an integer from 1 to
  14 (`MAX_NEXT_LESSONS_COUNT`, default 1, else `LearnerValidationError`) and
  returns up to that many unfinished (not complete or skipped) lessons per
  enrollment in lesson order, as the same flat entries; the default is
  unchanged.
- `listProgress` reads only the validated learner/enrollment and lessons still
  visible in that enrollment's course. Inconsistent persisted links fail
  closed or are omitted from the list.
- An enrollment with an `EnrollmentReleasePin` uses its effective lesson set
  instead of `enrollment.courseId` alone (`resolveEnrollmentLessons`, shared
  with `CourseAuthoringService.getEnrollmentRelease`, on the current executor):
  lessons started (non-`not_started` status or attempts) stay on their original
  immutable rows in any release the enrollment followed; the rest follow the
  current pin, in that release's order. `nextLessons`, `assignmentLessons`,
  `listProgress`, plan reads, `startLesson` and submission/workbook lesson
  assertions all use it, so a lesson outside the set is rejected and progress
  rows never move. Unpinned enrollments (or hosts without the authoring
  tables) read their own course as before. Pins recorded for another learner
  fail closed. `LessonProgress` accepts a lesson on any release course the
  enrollment is pinned to; no data migration.

Service results are data-only views, with no persistence or database methods.
Extra request fields are never model patches: a learner cannot set score,
attempt count, or completion status through this API. Curriculum activation,
enrollment completion and dashboard aggregation are not supported by this
base service. SubmissionService extends its owning transaction/auth boundary for
capture and guardian grading; see [submission contract](submission-service.md).
Direct model writes require trusted authority.

Catalog visibility and child ownership reuse `CatalogService` on the same
executor. Learner operations request private-inclusive catalog access, so the
host catalog authorizer must permit both `education.catalog.read` and
`education.catalog.read-private` for the supported enrollment workflow.
Private copies remain restricted to the exact owner. The service constructs a
whitelisted catalog request; caller options and answer-key flags are discarded.
Answer keys are never requested or returned. A catalog grant does not grant learner authorization.

## Transactions and history

`withTransaction(async transaction => ...)` composes service operations on the
callback's transaction-bound service. Use that service for every operation in
the unit. Throwing rolls back its curriculum, enrollment, and progress writes.
The callback's service closes when the transaction ends and rejects later calls.
A failed mutation poisons the unit even if the callback catches its rejection;
queued mutations are cancelled. Callback failure stops pending work and waits for
already-running mutations to settle before rollback releases the executor. On
success, already-enqueued mutations finish before commit. Do not retain the
callback's service beyond the callback. The constructor
accepts a root database; callers composing work use this method instead of
passing an unmanaged transaction handle.

PostgreSQL locks the parent curriculum/enrollment row before find-or-create.
Embedded writes use the core transaction queue. Concurrent mutations inside
one callback transaction are ordered on that connection, so duplicate starts
within a `Promise.all` also return the same row. Database natural-key constraints
arbitrate enrollment `(tenant_id, curriculum_id, course_id)` and progress
`(tenant_id, enrollment_id, lesson_id)` identities. Explicit storage conflict
keys include the tenant prefix because core does not add it to explicit keys.
The logical keys required by #3968 remain curriculum/course and enrollment/lesson:
immutable parent ownership and parent-tenant checks reject any second tenant
for the same parent. The storage prefix cannot create a second valid logical row. Ordinary repeated and concurrent calls
return one row; an aborted workflow can be retried. No in-memory process lock
is used for PostgreSQL concurrency.

A new year is a new curriculum and enrollment, producing independent progress.
Unscored `bestScore` persists as null; score zero is a real score. Scores are
nullable decimals in [0,1]; counters are nonnegative safe integers. Settings
are stored as JSON text and accessed through guarded `getSettings`/`setSettings`.

The shared executable workflows in `src/__tests__/learner-workflows.ts` run
against SQLite and PostgreSQL, including actor/resource/context denial,
concurrent creation, rollback, history preservation, and zero/null scores.
Full DuckDB schemas remain blocked by existing upstream DDL restrictions;
no full learner workflow support on DuckDB is claimed.
