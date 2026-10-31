# Course authoring contract

`CourseAuthoringService` (SMRT #4514, consumed by Hearth #68) writes revisioned,
family-owned courses and releases them into the existing Course/Section/Lesson
shape. Risk is high: tenancy, authorization, new schema and a public contract.
It is a standalone service (not a `LearnerService` subclass); every write is one
transaction and every authorizer call receives that transaction's executor.

## Models (closed, required tenant, no REST/CLI/MCP/AI)

`AuthoredCourse` (source key `authored`) stays the stable identity row; it never
holds content, is never assigned and its licence is never edited. Append-only:
`CourseRevision`, `LessonRevision` (stable `lessonKey` across versions; an
unchanged lesson reuses its row), `CourseRelease`, `ReleasedLesson`,
`CourseArchiveDecision`, `CourseDiscardTombstone`, `EnrollmentReleasePin`,
`CourseUpgradeChoice`. `CourseDraftHead` is the only mutable row and moves only
through the service's expected-head compare-and-swap. `save()` on an existing
append-only row and `delete()` throw; erasure belongs to a retention operation.
Schema ships via normal manifest migrations (additive: nine new tables, no
change to existing tables, test-pinned); the runtime never creates tables.

## Actions and host mapping

`education.course.read-draft|author|generate|review|release|assign|archive`. The host
maps roles; the authorizer also receives `operation`, `courseId`,
`enrollmentId`/`learnerId` and `delegatingGuardianUserId` (agent calls) and must
re-validate that delegation on the supplied executor. The service checks the
ambient tenant context, active actor and delegating-guardian membership first.
`generated` provenance additionally needs `generate`. Releasing and assigning
are independent grants: `pinEnrollment`, `upgradeEnrollment` and `setAutoUpgrade`
(operations `pin-enrollment`, `upgrade-enrollment`, `set-auto-upgrade`) use only
`assign`, never `release`. A host maps `assign` per learner from its assignment
setting (guardians only, guardians plus agents, learner can ask) using
`operation`, `enrollmentId`/`learnerId` and `delegatingGuardianUserId`; a
learner-initiated request is host policy, the service adds no learner authority.
Archive and discard use `archive`. `generate` and `review` are used by the [generation and review service](course-generation-review.md).
Foreign or missing courses/enrollments are not-found/denied alike.

Delegated actor: the authenticated actor is the agent; `delegatingGuardianUserId`
and a host `delegationId` (opaque, 1-200 printable characters) are validated as a
unit (one without the other is `invalid-request`; the guardian may not be the agent,
which is denied). Validation grants nothing: the guardian keeps no authority via the
agent, the host authorizer decides, and both users need active membership. One helper
(`course-delegation.ts`) builds actor, authorizer and record fields. `delegationId` is
passed to every authorizer call (all `education.course.*` actions, including the
per-enrollment `auto-upgrade` call, which gets the opt-in's recorded id) and recorded
(nullable on views) on revisions, releases, archive/discard, pins, opt-ins, skips
(`optInDelegationId`; automatic pins also record the opt-in's) and generation, review
and question records. Request-key replays compare it: another delegation id conflicts.
Assignment (`LearnerService.enroll`) is described in the [learner contract](learner-service.md).

## Writes

Every write requires a `requestKey`. A retried key replays its original result;
the same key with a different payload throws `CourseRequestKeyConflictError`.
`saveDraft` takes `expectedHeadRevisionId` and throws `CourseStaleHeadError`
(with the current head) when stale. Errors extend `CourseAuthoringError` with a
stable `code`; never match on messages.

## Release

`release` requires an injected `releaseReviewGate(executor, {tenantId, courseId,
revisionId}) => {current, reviewId?, reason?}`. No gate configured throws
`ReviewGateRequiredError`; `current !== true` throws `ReviewNotCurrentError`.
`createReviewBackedReleaseGate()` is the review-backed implementation (the default of
`CourseGenerationReviewService`; see [generation and review](course-generation-review.md)). The decision records actor,
delegating guardian and `reviewId`, one release per revision. It materializes a
release-only `AuthoredCourse` row (source key `authored-release`), sections and
`Lesson` subclasses whose ids derive deterministically from the revision id and
lesson identity; `Lesson.externalRef` and `ReleasedLesson` carry the stable
lesson identity for progress/reporting. Learners on different releases never
share mutable rows. Personal-use releases stay `draft` status (the existing rule).

## Enrollment pin and upgrades

`Enrollment` is untouched (its `courseId` stays immutable): enroll through
`LearnerService` on a release's `releaseCourseId`, then `pinEnrollment` records
the pin. `upgradeEnrollment` appends an explicit move to a newer release.
`setAutoUpgrade` records an opt-in/out at course or enrollment level (enrollment
wins) for future releases; each automatic move is a recorded pin without actor. Pin, upgrade and
`setAutoUpgrade` requests require a host-supplied `policyBasis` (the
assignment-setting value relied on, e.g. `guardians-only`; 1-200 chars, else
`invalid-request`), recorded with actor and delegating guardian on the pin or
choice row and exposed on the views. An automatic move copies the basis of the
opt-in that governs it, plus its `optInScope` (`course`|`enrollment`). Each
automatic move is authorized per enrollment during `release` with action
`assign`, operation `auto-upgrade`, that `enrollmentId`/`learnerId`, the opt-in's
recorded actor and delegating guardian (current membership re-checked, the host
re-evaluates the delegation or relationship) and the transaction executor; hosts
must map `auto-upgrade` per learner from the assignment setting. A denial or
authorizer failure (each call runs in a SAVEPOINT, rolled back on a throw, so a failing host statement cannot abort the release transaction) never blocks the release or other enrollments: that
enrollment stays on its pin and an `EnrollmentAutoUpgradeSkip` row records
`not-authorized` (or the authorizer's `reason`), the optional `code`, the opt-in scope, actor,
guardian and `policyBasis`. A replayed
request key with a different basis is a request-key conflict.
`getEnrollmentRelease` returns the pin and effective lessons: after any move
(automatic or explicit), started lessons stay on the immutable row they were
started on, unstarted lessons follow the current release. `LearnerService`
consumes the same rule (see `learner-service.md`).

## Authorizer answers

An authorizer returns `boolean` or `{ allowed, reason?, code? }` (only `allowed: true`
allows). On an auto-upgrade denial `reason` (at most 200 characters, control characters
stripped) and `code` (`[a-z0-9._-]`, at most 64; e.g. `assignment-setting`,
`agent-permission`, `guardian-link`) are stored on the skip; invalid values fall back to
`not-authorized` and an empty code. A thrown error's message is never recorded.

## Reads

All use `read-draft`, the executor and delegation fields, and are tenant-exact (a foreign
course is not-found, a foreign enrollment a denial). Lists take `limit` (default 50, capped at
100) and an opaque `cursor`, and return `{ items, nextCursor }` in a total order.
- `listCourses({ includeDiscarded? })` (operation `list-courses`): `CourseSummaryView`
  per course: state, `head` (`revisionId` is the expected-head token), `latestRelease`,
  `archive`. Oldest first; discarded courses only when requested.
- `listUpgradeChoices({ courseId, enrollmentId? })` (`list-upgrade-choices`): opt-in/out
  history in sequence order; with an enrollment, its own rows plus `governing`.
- `listAutoUpgradeSkips({ courseId?, enrollmentId? })` (`list-auto-upgrade-skips`, one
  required): `AutoUpgradeSkipView` with `reason`, `code`, opt-in actor/guardian/delegation.
- `QuestionAuthoringService.readReleasedLesson({ releaseId, lessonKey })`
  (`read-released-lesson`): lesson revision, layout and the keyed worksheet bundle.
- `QuestionResponseService.readReleasedLesson({ enrollmentId, lessonId })` (learner
  authorizer, `education.learner.read`; the learner or an authorized guardian): only the
  enrollment's effective lessons (else `QuestionResponseScopeError`), keyless bundle,
  no materials or provenance, personal-use body withheld (`bodyWithheld`).

## Archive and discard

`archive`/`unarchive` append reversible decisions, mirror release `Course.status`
for catalog listings only and never touch enrollments, progress, submissions,
grades, workbooks, notes or evidence. Archived courses refuse release, new pins
and upgrades. `discardDraft` ends an unreferenced draft with a tombstone (history
stays); it is refused (`CourseDiscardRefusedError.references`) for releases and
enrollments, and for review/generation/variant rows via the injected `referenceGuard`
(`createCourseReferenceGuard`).

## Licence and sharing

Most restrictive wins: own-work < open-license < licensed-for-sharing <
personal-use-copy (`mostRestrictiveLicense`). A lesson's own licence folds every restriction the course ever recorded
for its `lessonKey` or its normalized content, so rename, omitted keys and
remove-then-re-add keep it; only dropping that content lifts it, and a
`lessonKey` once restricted stays restricted. A reused asset keeps the most
restrictive licence ever recorded for it. Uploaded materials default to
`personal-use-copy` unless the author states otherwise. Any personal-use part
makes the course tenant-private: `GroupSharingWorkFacts.courseShareable=false`
(reason `course-private`) for authored releases, and the policy option list hides
them. Work is attributed to the course of its own lesson, and any personal-use
release anywhere in the enrollment's pin lineage also makes it `course-private`
and hides the course from the options; unpinned enrollments and databases without the pin tables are unchanged. Existing workbook personal-use scaffolds are unchanged.

## Materials

Uploads are copied by the injected `materialCopy` port into education-owned
assets (tenant-checked afterwards) with source/actor/time provenance, so
ingestion expiry never removes them; replays never copy twice, and a port must
not leave side effects outside the transaction it cannot compensate. Releases
link them with `LessonAsset` under private asset access for personal-use and
answer-key material.
