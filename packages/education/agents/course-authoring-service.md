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

`education.course.read-draft|author|generate|review|release|archive`. The host
maps roles; the authorizer also receives `operation`, `courseId`,
`enrollmentId`/`learnerId` and `delegatingGuardianUserId` (agent calls) and must
re-validate that delegation on the supplied executor. The service checks the
ambient tenant context, active actor and delegating-guardian membership first.
`generated` provenance additionally needs `generate`. Enrollment pin, upgrade
and auto-upgrade choices use `release` (deny them per `operation` for agents if
wanted); archive and discard use `archive`. `generate` and `review` are used by the [generation and review service](course-generation-review.md).
Foreign or missing courses/enrollments are not-found/denied alike.

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
wins) for future releases; each automatic move is a recorded pin without actor.
`getEnrollmentRelease` returns the pin and effective lessons: after automatic
moves, started lessons stay on their original release's immutable row, unstarted
lessons follow the current release; an explicit upgrade moves every lesson.
LearnerService projections still read `enrollment.courseId`; consuming the
effective set there is a follow-up that needs its own migration window.

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
remove-then-re-add keep it; only not carrying that content lifts it. and a reused asset keeps the most restrictive licence ever recorded for it. Uploaded materials default to
`personal-use-copy` unless the author states otherwise. Any personal-use part
makes the course tenant-private: `GroupSharingWorkFacts.courseShareable=false`
(reason `course-private`) for authored releases, and the policy option list hides
them. Existing workbook personal-use scaffolds are unchanged.

## Materials

Uploads are copied by the injected `materialCopy` port into education-owned
assets (tenant-checked afterwards) with source/actor/time provenance, so
ingestion expiry never removes them; replays never copy twice, and a port must
not leave side effects outside the transaction it cannot compensate. Releases
link them with `LessonAsset` under private asset access for personal-use and
answer-key material.
